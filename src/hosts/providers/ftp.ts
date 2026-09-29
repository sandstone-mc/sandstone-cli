import { Client as FtpClient } from 'basic-ftp'
import { Writable, Readable } from 'node:stream'

import { HostAuthError, NotConnectedError } from '../errors.js'
import { RconClient } from '../rcon-client.js'
import { Capability, type FtpHostConfig, type HostCapabilities, type HostProvider, type LogChunkHandler, type LogSubscription, type ServerPath } from '../types.js'


/**
 * FTP provider — read/write files and poll-based log attachment.
 * Optionally exposes `executeRawCommand` over RCON when `config.rcon`
 * is set with `enabled !== false` (FTP itself has no native exec
 * channel — RCON is the only way to send console commands to an
 * FTP-managed server).
 *
 * FTP has no native streaming/log interface, so `attachLog` polls the log
 * file every `pollIntervalMs`, fetches the byte delta since the last poll,
 * and emits new lines. Detects Minecraft's `latest.log` rotation by size
 * shrink.
 */
export class FtpHost implements HostProvider {
  readonly type = 'ftp' as const
  readonly displayName = 'FTP'
  readonly capabilities: HostCapabilities = (() => {
    const set: HostCapabilities = new Set([
      Capability.ReadFile,
      Capability.WriteFile,
      Capability.AttachLog,
    ])
    return set
  })()

  private readonly client = new FtpClient()
  private readonly config: FtpHostConfig
  private connected = false
  /** Optional RCON client — only set when `config.rcon` is configured with `enabled !== false`. */
  private rcon: RconClient | null = null

  constructor(config: FtpHostConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const { host, port, user, password } = this.config
    try {
      await this.client.access({ host, port, user, password })
    } catch (err) {
      throw new HostAuthError(
        err instanceof Error ? `FTP connect failed: ${err.message}` : 'FTP connect failed',
      )
    }
    this.connected = true
    // Open RCON if configured. Same host as FTP — the MC server's
    // RCON listener binds alongside its main port. Failure here is
    // not fatal (file/log still works) but should be reported so the
    // user knows `executeRawCommand` won't work.
    const rconCfg = this.config.rcon
    if (rconCfg && rconCfg.enabled !== false && rconCfg.port && rconCfg.password) {
      const rcon = new RconClient({
        host: this.config.host,
        port: rconCfg.port,
        password: rconCfg.password,
      })
      try {
        await rcon.authenticate()
        this.rcon = rcon
        // Only add the capability once auth actually succeeded —
        // otherwise we'd advertise a method we can't honor.
        this.capabilities.add(Capability.ExecuteRawCommand)
        this.capabilities.add(Capability.ExecuteRawCommandHasResponse)
      } catch (err) {
        this.rcon = null
        console.error(`[ftp] RCON authenticate failed (${err instanceof Error ? err.message : err}) — executeRawCommand disabled`)
      }
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    if (this.rcon) {
      try { this.rcon.destroy() } catch { /* ignore */ }
      this.rcon = null
    }
    try {
      this.client.close()
    } finally {
      this.connected = false
    }
  }

  isConnected(): boolean {
    return this.connected && !this.client.closed
  }

  async executeRawCommand(command: string): Promise<string> {
    this.requireConnected('ftp')
    if (!this.rcon) {
      throw new Error(
        `FTP host has no RCON configured — set \`rcon\` in the host config to enable executeRawCommand.`,
      )
    }
    return await this.rcon.execute(command)
  }

  async readFile(path: ServerPath): Promise<Buffer> {
    this.requireConnected('ftp')
    const chunks: Buffer[] = []
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        cb()
      },
    })
    await this.client.downloadTo(sink, this.resolvePath(path))
    return Buffer.concat(chunks)
  }

  async writeFile(path: ServerPath, data: Buffer | string): Promise<void> {
    this.requireConnected('ftp')
    // basic-ftp's uploadFrom takes a Readable | string. Wrap a Buffer in a
    // one-shot Readable stream so we can push the full payload through.
    const source = Readable.from(typeof data === 'string' ? Buffer.from(data) : data)
    await this.client.uploadFrom(source, this.resolvePath(path))
  }

  async attachLog(onChunk: LogChunkHandler): Promise<LogSubscription> {
    this.requireConnected('ftp')
    const intervalMs = this.config.pollIntervalMs ?? 500
    const logPath = this.resolvePath(this.config.logPath ?? 'logs/latest.log')
    let lastSize = 0
    let lastMtime = 0
    let buffer = ''
    let stopped = false
    let timer: NodeJS.Timeout | null = null

    const flushLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (lines.length > 0) onChunk(lines)
    }

    const tick = async () => {
      if (stopped) return
      try {
        // Probe size + mtime; rotation detection: file shrunk below
        // lastSize means Minecraft renamed `latest.log` to `latest.log.1`
        // and started a new file.
        const size = await this.client.size(logPath)
        const mtime = (await this.client.lastMod(logPath)).getTime()

        if (size < lastSize || mtime + 1000 < lastMtime) {
          // Rotation — restart from offset 0.
          lastSize = 0
          buffer = ''
        }

        if (size > lastSize) {
          let chunkBuffer = ''
          const sink = new Writable({
            write(chunk: Buffer, _enc, cb) {
              chunkBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
              cb()
            },
          })
          await this.client.downloadTo(sink, logPath, lastSize)
          // After `downloadTo` with startAt, the chunkBuffer holds exactly
          // the bytes since lastSize. Append to our line buffer.
          buffer += chunkBuffer
          flushLines()
          lastSize = size
          lastMtime = mtime
        }
      } catch {
        // Transient errors during a poll (file briefly missing, connection
        // blip) are tolerated. The next tick will retry.
      } finally {
        if (!stopped) timer = setTimeout(tick, intervalMs)
      }
    }

    // Prime: fetch initial size so the first poll doesn't replay the
    // entire log from byte 0.
    try {
      lastSize = await this.client.size(logPath)
      lastMtime = (await this.client.lastMod(logPath)).getTime()
    } catch {
      // File may not exist yet — start from 0 and let the first tick
      // pick up once it appears.
      lastSize = 0
      lastMtime = 0
    }
    timer = setTimeout(tick, intervalMs)

    return {
      async unattach() {
        if (stopped) return
        stopped = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (buffer.length > 0) {
          onChunk([buffer])
          buffer = ''
        }
      },
    }
  }

  // ---------------------------------------------------------------------

  private requireConnected(label: string): void {
    if (!this.connected) throw new NotConnectedError(label)
  }

  private resolvePath(path: ServerPath): string {
    const base = this.config.basePath?.replace(/\/+$/, '') ?? ''
    if (!base) return path
    if (path.startsWith('/')) return `${base}${path}`
    return `${base}/${path}`.replace(/\/+/g, '/')
  }
}

/** Factory used by the registry. */
export function createFtpHost(config: FtpHostConfig): HostProvider {
  return new FtpHost(config)
}