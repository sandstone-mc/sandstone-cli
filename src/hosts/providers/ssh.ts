import { NodeSSH, type Config as NodeSshConfig } from 'node-ssh'
import { Readable, Writable } from 'node:stream'

import { HostAuthError, NotConnectedError } from '../errors.js'
import { RconClient } from '../rcon-client.js'
import { attachRconIfConfigured } from '../_shared/attach-rcon.js'
import { Capability, type HostCapabilities, type HostProvider, type LogChunkHandler, type LogSubscription, type ServerPath, type SshHostConfig } from '../types.js'

/**
 * SSH provider — file I/O (SFTP), shell exec, and log attachment via the
 * `node-ssh` library. Optionally exposes `executeRawCommand` over RCON
 * when `config.rcon` is set with `enabled !== false`. SSH's built-in
 * `execCommand` is reserved for `startCommand`/`stopCommand` (those
 * aren't `executeRawCommand` — they're lifecycle hooks).
 *
 * If `config.rcon` is absent but `config.consoleSession` is set,
 * `executeRawCommand` falls back to driving the named screen/tmux
 * session — same path `stopServer` uses for graceful shutdown. Console
 * sessions are fire-and-forget (no command output), so this path does
 * NOT advertise `ExecuteRawCommandHasResponse`; only `executeRawCommand`
 * over RCON does.
 *
 * Lifecycle:
 *  - `startServer`: runs `startCommand` via `execCommand`.
 *  - `stopServer`: if `consoleSession` is set, drives `stop` through the
 *    screen/tmux session internally as a graceful first attempt, then
 *    falls back to `stopCommand` after `gracefulStopTimeoutSeconds`.
 *  - `attachLog`: runs `tail -F -n 0` over SSH and forwards each new
 *    line.
 *  - `executeRawCommand` (optional): RCON when configured, otherwise
 *    the console session if set, otherwise absent.
 */
export class SshHost implements HostProvider {
  readonly type = 'ssh' as const
  readonly displayName = 'SSH'
  readonly capabilities: HostCapabilities = new Set([
    Capability.StartServer,
    Capability.StopServer,
    Capability.ReadFile,
    Capability.WriteFile,
    Capability.WriteFileStream,
    Capability.AttachLog,
  ])

  private readonly ssh = new NodeSSH()
  private readonly config: SshHostConfig
  private connected = false
  /** Optional RCON client — only set when `config.rcon` is configured with `enabled !== false`. */
  private rcon: RconClient | null = null

  constructor(config: SshHostConfig) {
    this.config = config
    // Advertise `executeRawCommand` early when the console-session
    // fallback is available; the richer `ExecuteRawCommandHasResponse`
    // capability is added later by `attachRconIfConfigured` if RCON is
    // also configured (it supersedes the fire-and-forget path).
    if (config.consoleSession) {
      this.capabilities.add(Capability.ExecuteRawCommand)
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const { host, port, username, password, privateKey } = this.config
    const connectConfig: NodeSshConfig = {
      host,
      username,
      ...(port !== undefined ? { port } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(privateKey !== undefined ? { privateKey } : {}),
    }
    try {
      await this.ssh.connect(connectConfig)
    } catch (err) {
      throw new HostAuthError(
        err instanceof Error ? `SSH connect failed: ${err.message}` : 'SSH connect failed',
      )
    }
    this.connected = true
    // Open RCON if configured. Same host as SSH — the MC server's
    // RCON listener binds alongside its main port.
    await attachRconIfConfigured(
      this.config.rcon,
      this.config.host,
      'ssh',
      (msg) => console.error(msg),
      { setRcon: (r) => { this.rcon = r }, addCapability: (c) => this.capabilities.add(c) },
    )
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    if (this.rcon) {
      try { this.rcon.destroy() } catch { /* ignore */ }
      this.rcon = null
    }
    try {
      this.ssh.dispose()
    } finally {
      this.connected = false
    }
  }

  isConnected(): boolean {
    return this.connected && this.ssh.isConnected()
  }

  async startServer(): Promise<void> {
    this.requireConnected('ssh')
    const result = await this.ssh.execCommand(this.config.startCommand, {
      cwd: this.config.serverDir,
    })
    if (result.code !== 0 && result.code !== null) {
      throw new Error(
        `startCommand exited with code ${result.code}: ${result.stderr || result.stdout}`,
      )
    }
  }

  async stopServer(): Promise<void> {
    this.requireConnected('ssh')
    const timeoutMs =
      (this.config.gracefulStopTimeoutSeconds ?? 30) * 1000

    if (this.config.consoleSession) {
      // Drive Minecraft's `stop` console command via screen/tmux so the
      // server can flush + save before exiting. This is internal-only — we
      // do NOT expose this via `executeRawCommand`.
      const session = this.config.consoleSession
      const keystroke = await this.sendToConsole(session, 'stop')
      if (keystroke) {
        const exited = await this.waitForProcessExit(timeoutMs)
        if (exited) return
      }
    }

    // Fallback: hard stop.
    const result = await this.ssh.execCommand(this.config.stopCommand, {
      cwd: this.config.serverDir,
    })
    if (result.code !== 0 && result.code !== null) {
      throw new Error(
        `stopCommand exited with code ${result.code}: ${result.stderr || result.stdout}`,
      )
    }
  }

  async readFile(path: ServerPath): Promise<Buffer> {
    this.requireConnected('ssh')
    const sftp = await this.ssh.requestSFTP()
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = sftp.createReadStream(this.resolvePath(path))
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      })
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })
  }

  /**
   * Expose the underlying SFTP read stream directly so the daemon
   * can pipe chunks out as they arrive. `size` is best-effort via
   * `stat()` — left undefined on failure since the host runs on a
   * remote filesystem where stat errors aren't fatal to the read.
   */
  async readFileStream(path: ServerPath): Promise<{ stream: ReadableStream<Uint8Array>; size?: number }> {
    this.requireConnected('ssh')
    const sftp = await this.ssh.requestSFTP()
    // Probe with `stat` first. ssh2's `createReadStream` opens the
    // stream asynchronously and emits an `'error'` event on failure,
    // but the SFTP protocol layer also rejects an internal Promise
    // we have no handle on — that rejection is uncaught and crashes
    // the daemon. By failing fast on `stat`, we never open the
    // stream for a missing path; the consumer sees a clean RPC
    // error via the dispatch handler's catch.
    let size: number | undefined
    try {
      const stat = await new Promise<{ attrs?: { size?: number } }>((resolve, reject) => {
        sftp.stat(this.resolvePath(path), (err: Error | undefined, stats: unknown) => {
          if (err) reject(err)
          else resolve(stats as { attrs?: { size?: number } })
        })
      })
      size = stat.attrs?.size
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }
    const node = sftp.createReadStream(this.resolvePath(path))
    // Even after the stat check, attach a defensive listener so any
    // error emitted after open (network drop mid-read, etc.) doesn't
    // become uncaught. `Readable.toWeb()` is supposed to forward to
    // the web stream's controller, but ssh2's internal Promise
    // rejection is what we actually need to keep unhandled — this
    // listener covers the raw `'error'` event half.
    node.on('error', () => { /* handled via web stream controller */ })
    return { stream: Readable.toWeb(node) as ReadableStream<Uint8Array>, size }
  }

  async writeFile(path: ServerPath, data: Buffer | string): Promise<void> {
    this.requireConnected('ssh')
    const sftp = await this.ssh.requestSFTP()
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(this.resolvePath(path))
      stream.on('error', reject)
      stream.on('close', () => resolve())
      stream.end(typeof data === 'string' ? Buffer.from(data) : data)
    })
  }

  /**
   * Open an SFTP write stream for the daemon to pipe chunks into.
   * The returned `WritableStream` wraps the underlying SFTP stream
   * via `Readable.toWeb` / `Writable.toWeb` — Bun implements both
   * directions of the web stream API and the conversion is lossless.
   *
   * `opts.size` is ignored — ssh2's SFTP `WriteStream` is a true
   * streaming sink, so the file size doesn't need to be known up
   * front.
   */
  async writeFileStream(path: ServerPath, _opts?: { size?: number }): Promise<WritableStream<Uint8Array>> {
    this.requireConnected('ssh')
    const sftp = await this.ssh.requestSFTP()
    const node = sftp.createWriteStream(this.resolvePath(path))
    // Same rationale as readFileStream: `Writable.toWeb()` forwards
    // the Node stream's `error` event to the web stream's writer,
    // but the raw `error` event is still uncaught unless someone
    // listens. Open failures (bad path, permission denied, etc.)
    // would otherwise crash the daemon before the consumer's
    // writer.write() rejection fires.
    node.on('error', () => { /* handled via web stream */ })
    // SFTP's createWriteStream returns a `WriteStream`. Cast through
    // `unknown` because `Writable.toWeb`'s overload narrowing doesn't
    // accept the SFTP-specific stream shape directly.
    return Writable.toWeb(node) as WritableStream<Uint8Array>
  }

  async executeRawCommand(command: string): Promise<string | undefined> {
    this.requireConnected('ssh')
    if (this.rcon) {
      return await this.rcon.execute(command)
    }
    if (this.config.consoleSession) {
      const ok = await this.sendToConsole(this.config.consoleSession, command)
      if (!ok) {
        throw new Error(
          `SSH host could not deliver \`${command}\` via console session \`${this.config.consoleSession}\` (no \`screen\` or \`tmux\` available on the remote host).`,
        )
      }
      // Console sessions are fire-and-forget — there's no response
      // channel. The command's output, if any, streams through the
      // attached server log.
      return undefined
    }
    throw new Error(
      `SSH host has neither \`rcon\` nor \`consoleSession\` configured — set one in the host config to enable executeRawCommand.`,
    )
  }

  async attachLog(onChunk: LogChunkHandler): Promise<LogSubscription> {
    this.requireConnected('ssh')
    const logPath = this.config.logPath ?? `${this.config.serverDir}/logs/latest.log`
    // The ssh2 SFTP ReadStream built-in streaming is the right tool
    // for very fast logs with proper metadata (size/mtime for
    // rotation). It only works when the consumer keeps the read
    // stream fed — any quiescent second kills the subscription via
    // EOF. Minecraft's `logs/latest.log` is bursty, not chatty,
    // so the ssh stream dies between writes and the consumer sees
    // nothing. `tail -F` follows the inode and survives bursts +
    // rotation, which is what MC logs actually need.
    return await this.attachLogViaTail(logPath, onChunk)
  }

  // ---------------------------------------------------------------------

  private resolvePath(path: ServerPath): string {
    if (path.startsWith('/')) return path
    return `${this.config.serverDir}/${path}`.replace(/\/+/g, '/')
  }

  private requireConnected(label: string): void {
    if (!this.connected) throw new NotConnectedError(label)
  }

  private async sendToConsole(session: string, command: string): Promise<boolean> {
    // Try `screen` first, fall back to `tmux`. Each delivers `command` +
    // Enter to the named session. Either returning non-zero is treated as
    // "couldn't drive the session" and the caller falls back to its
    // alternative path (hard-stop command, or the MCP tool surfaces the
    // failure).
    try {
      const screen = await this.ssh.execCommand(
        `screen -S ${JSON.stringify(session)} -X stuff ${JSON.stringify(command + '\\n')}`,
      )
      if (screen.code === 0) return true
    } catch {
      // ignore — try tmux next
    }
    try {
      const tmux = await this.ssh.execCommand(
        `tmux send-keys -t ${JSON.stringify(session)} ${JSON.stringify(command)} Enter`,
      )
      return tmux.code === 0
    } catch {
      return false
    }
  }

  private async waitForProcessExit(timeoutMs: number): Promise<boolean> {
    // Poll `pgrep -f <startCommand>` until it returns no rows or we time out.
    // This is intentionally simple — `startCommand` may have spawned a child
    // that we don't have a direct handle on, so we detect by process
    // disappearance.
    const deadline = Date.now() + timeoutMs
    const intervalMs = 500
    while (Date.now() < deadline) {
      try {
        const { stdout, code } = await this.ssh.execCommand(
          `pgrep -f ${JSON.stringify(this.config.startCommand)} || true`,
        )
        if (code === 0 && stdout.trim() === '') return true
      } catch {
        // Treat probe failure as "still running" — better to wait than to
        // escalate to `stopCommand` prematurely.
      }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return false
  }

  private async attachLogViaTail(
    logPath: string,
    onChunk: LogChunkHandler,
  ): Promise<LogSubscription> {
    // Use execCommand's onStdout callback to stream. node-ssh keeps the
    // channel open for the duration of the remote process; we resolve
    // unattach() by disposing the parent SSH connection — but that's
    // destructive across other capabilities. Instead, we accept the
    // limitation: the tail channel stays open until the SSH session ends
    // (provider disconnect). unattach() simply detaches our local handler.
    let stopped = false
    let buffer = ''
    const flushLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (lines.length > 0) onChunk(lines)
    }

    // Fire-and-forget; node-ssh does not expose a direct kill for an exec
    // channel, so we let it run until disconnect(). `-n 0` skips existing
    // content and starts at EOF — subscribers get only lines emitted
    // after they subscribed (matches local-client + integrated).
    this.ssh.execCommand(`tail -F -n 0 ${JSON.stringify(logPath)}`, {
        cwd: this.config.serverDir,
        onStdout: (chunk: Buffer) => {
          if (stopped) return
          buffer += chunk.toString('utf8')
          flushLines()
        },
      })
      .catch(() => {
        // tail exits when the file is unlinked or the channel closes;
        // nothing actionable here.
      })

    return {
      async unattach() {
        stopped = true
        if (buffer.length > 0) {
          onChunk([buffer])
          buffer = ''
        }
      },
    }
  }
}

/** Factory used by the registry. */
export function createSshHost(config: SshHostConfig): HostProvider {
  return new SshHost(config)
}