import { Readable } from 'node:stream'
import { NodeSSH, type Config as NodeSshConfig } from 'node-ssh'

import { HostAuthError, NotConnectedError } from '../errors.js'
import type {
  HostCapabilities,
  HostProvider,
  LogChunkHandler,
  LogSubscription,
  ServerPath,
  SshHostConfig,
} from '../types.js'
import { ALL_CAPABILITIES_OFF } from '../types.js'

/**
 * SSH provider — file I/O (SFTP), shell exec, and log attachment via the
 * `node-ssh` library. Does NOT implement `executeRawCommand`: that
 * capability is for the Minecraft console protocol (RCON / WS / stdin),
 * and SSH only speaks shell. Compose with an RCON provider via
 * `CompositeHost` if you need both.
 *
 * Lifecycle:
 *  - `startServer`: runs `startCommand` via `execCommand`.
 *  - `stopServer`: if `consoleSession` is set, drives `stop` through the
 *    screen/tmux session internally as a graceful first attempt, then
 *    falls back to `stopCommand` after `gracefulStopTimeoutSeconds`.
 *  - `attachLog`: SFTP streaming (default) or `tail -F` shell streaming
 *    (opt-in via `attachStrategy: 'tail'`).
 */
export class SshHost implements HostProvider {
  readonly type = 'ssh' as const
  readonly displayName = 'SSH'
  readonly capabilities: HostCapabilities = {
    ...ALL_CAPABILITIES_OFF,
    startServer: true,
    stopServer: true,
    readFile: true,
    writeFile: true,
    attachLog: true,
  }

  private readonly ssh = new NodeSSH()
  private readonly config: SshHostConfig
  private connected = false

  constructor(config: SshHostConfig) {
    this.config = config
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
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
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
      const keystroke = await this.trySendStopToConsole(session)
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

  async attachLog(onChunk: LogChunkHandler): Promise<LogSubscription> {
    this.requireConnected('ssh')
    const strategy = this.config.attachStrategy ?? 'sftp-stream'
    const logPath = this.config.logPath ?? `${this.config.serverDir}/logs/latest.log`

    if (strategy === 'sftp-stream') {
      return await this.attachLogViaSftp(logPath, onChunk)
    }
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

  private async trySendStopToConsole(session: string): Promise<boolean> {
    // Try `screen` first, fall back to `tmux`. Each sends the `stop` mc
    // console command + Enter to the named session. Either returning
    // non-zero is treated as "couldn't drive the session" and we skip
    // straight to `stopCommand`.
    try {
      const screen = await this.ssh.execCommand(
        `screen -S ${JSON.stringify(session)} -X stuff "stop\\n"`,
      )
      if (screen.code === 0) return true
    } catch {
      // ignore — try tmux next
    }
    try {
      const tmux = await this.ssh.execCommand(
        `tmux send-keys -t ${JSON.stringify(session)} 'stop' Enter`,
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

  private async attachLogViaSftp(
    logPath: string,
    onChunk: LogChunkHandler,
  ): Promise<LogSubscription> {
    const sftp = await this.ssh.requestSFTP()
    let stream: Readable = sftp.createReadStream(logPath, { start: 0 })
    let buffer = ''
    let watcher: NodeJS.Timeout | null = null
    let lastSize = 0
    let stopped = false

    const flushLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (lines.length > 0) onChunk(lines)
    }

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      flushLines()
    }
    const onError = (err: Error) => {
      if (stopped) return
      // Swallow after-stop errors silently — the consumer has already
      // moved on by the time unattach() resolves.
      // eslint-disable-next-line no-console
      console.error('ssh attachLog stream error:', err)
    }

    stream.on('data', onData)
    stream.on('error', onError)

    // Poll for rotation: Minecraft renames `latest.log` to `latest.log.1`
    // when the current file grows; if `stat.size` shrinks below what we've
    // read, destroy + reopen from offset 0.
    const lastStat = (): Promise<{ size: number } | null> =>
      new Promise((resolve) => {
        sftp.stat(logPath, (err: Error | null, stats?: { size: number }) => {
          if (err || !stats) resolve(null)
          else resolve({ size: stats.size })
        })
      })

    watcher = setInterval(async () => {
      if (stopped) return
      const stat = await lastStat()
      if (stat && stat.size < lastSize) {
        // Rotation — close + reopen.
        stream.removeListener('data', onData)
        stream.removeListener('error', onError)
        stream.destroy()
        buffer = ''
        try {
          const reopened = sftp.createReadStream(logPath, { start: 0 })
          reopened.on('data', onData)
          reopened.on('error', onError)
          stream = reopened
          lastSize = 0
        } catch {
          // If reopen fails, give up; consumer will see no further chunks.
        }
      } else if (stat) {
        lastSize = stat.size
      }
    }, 2000)

    return {
      async unattach() {
        if (stopped) return
        stopped = true
        if (watcher) clearInterval(watcher)
        watcher = null
        stream.removeListener('data', onData)
        stream.removeListener('error', onError)
        stream.destroy()
        // Flush any trailing partial line as-is (no newline = incomplete).
        if (buffer.length > 0) {
          onChunk([buffer])
          buffer = ''
        }
      },
    }
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
    // channel, so we let it run until disconnect().
    void this.ssh
      .execCommand(`tail -F ${JSON.stringify(logPath)}`, {
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