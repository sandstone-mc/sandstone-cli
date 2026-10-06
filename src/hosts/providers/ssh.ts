import { NodeSSH } from 'node-ssh'
import { Readable, Writable } from 'node:stream'

import { HostAuthError, NotConnectedError } from '../errors.js'
import { RconClient } from '../rcon-client.js'
import { attachRconIfConfigured } from '../_shared/attach-rcon.js'
import { HostProvider, Capability } from '../types.js'

import type { Config as NodeSshConfig } from 'node-ssh'
import type { DaemonLogger, SshHostConfig, HostCapabilities, HostLogHandler } from '../types.js'

export class SshHost extends HostProvider {
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
  private rcon: RconClient | null = null
  private tailState: TailState | null = null

  constructor(config: SshHostConfig, logger: DaemonLogger) {
    super(logger)
    this.config = config
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
    await attachRconIfConfigured(
      this.config.rcon,
      this.config.host,
      'ssh',
      (msg) => this.logger.error(msg),
      { setRcon: (r) => { this.rcon = r }, addCapability: (c) => this.capabilities.add(c) },
    )
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    if (this.rcon) {
      try { this.rcon.destroy() } catch {}
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

  async readFile(path: string): Promise<Buffer> {
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

  async readFileStream(path: string) {
    this.requireConnected('ssh')
    const sftp = await this.ssh.requestSFTP()
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
    node.on('error', () => {})
    return { stream: Readable.toWeb(node) as ReadableStream<Uint8Array>, size }
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    this.requireConnected('ssh')
    const sftp = await this.ssh.requestSFTP()
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(this.resolvePath(path))
      stream.on('error', reject)
      stream.on('close', () => resolve())
      stream.end(typeof data === 'string' ? Buffer.from(data) : data)
    })
  }

  async writeFileStream(path: string, _opts?: { size?: number }) {
    this.requireConnected('ssh')
    const sftp = await this.ssh.requestSFTP()
    const node = sftp.createWriteStream(this.resolvePath(path))
    node.on('error', () => {})
    return Writable.toWeb(node) as WritableStream<Uint8Array>
  }

  async executeRawCommand(command: string) {
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
      return undefined
    }
    throw new Error(
      `SSH host has neither \`rcon\` nor \`consoleSession\` configured — set one in the host config to enable executeRawCommand.`,
    )
  }

  async attachLog(onChunk: HostLogHandler) {
    this.requireConnected('ssh')
    const logPath = this.config.logPath ?? `${this.config.serverDir}/logs/latest.log`
    let state = this.tailState
    if (state === null) {
      state = { channel: null, buffer: '', handlers: new Set<HostLogHandler>() }
      this.tailState = state

      this.ssh.execCommand(`tail -F -n 0 ${JSON.stringify(logPath)}`, {
        cwd: this.config.serverDir,
        onChannel: (channel) => {
          if (state !== null) state.channel = channel
        },
        onStdout: (chunk: Buffer) => {
          if (state === null) return
          state.buffer += chunk.toString('utf8')
          const lines = state.buffer.split('\n')
          state.buffer = lines.pop() ?? ''
          if (lines.length > 0) {
            const payload = lines.map((line: string) => ({ line, ts: Date.now(), stream: 'stdout' as const }))
            for (const h of state.handlers) h(payload)
          }
        },
      }).catch(() => {
        if (state !== null && this.tailState === state) {
          this.tailState = null
          state = null
        }
      })
    }

    state.handlers.add(onChunk)
    return {
      unattach: async () => {
        if (state === null) return
        state.handlers.delete(onChunk)
        if (state.handlers.size === 0) {
          try { state.channel?.close() } catch {}
          if (this.tailState === state) {
            this.tailState = null
          }
          state = null
        }
      },
    }
  }

  private resolvePath(path: string): string {
    if (path.startsWith('/')) return path
    return `${this.config.serverDir}/${path}`.replace(/\/+/g, '/')
  }

  private requireConnected(label: string): void {
    if (!this.connected) throw new NotConnectedError(label)
  }

  private async sendToConsole(session: string, command: string): Promise<boolean> {
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
    const deadline = Date.now() + timeoutMs
    const intervalMs = 500
    while (Date.now() < deadline) {
      try {
        const { stdout, code } = await this.ssh.execCommand(
          `pgrep -f ${JSON.stringify(this.config.startCommand)} || true`,
        )
        if (code === 0 && stdout.trim() === '') return true
      } catch {}
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return false
  }
}

export function createSshHost(config: SshHostConfig, logger: DaemonLogger): HostProvider {
  return new SshHost(config, logger)
}

interface SshChannelLike {
  close(): void
}

interface TailState {
  channel: SshChannelLike | null
  buffer: string
  handlers: Set<HostLogHandler>
}