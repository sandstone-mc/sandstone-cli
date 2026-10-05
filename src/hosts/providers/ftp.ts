import { Client as FtpClient } from 'basic-ftp'
import { Readable, Writable, PassThrough } from 'stream'

import { HostAuthError, NotConnectedError } from '../errors.js'
import { RconClient } from '../rcon-client.js'
import { attachRconIfConfigured } from '../_shared/attach-rcon.js'
import { HostProvider, Capability } from '../types.js'

import type { DaemonLogger, FtpHostConfig, HostCapabilities, HostLogLine, HostLogHandler, LogSubscription } from '../types.js'

export class FtpHost extends HostProvider {
  readonly type = 'ftp' as const
  readonly displayName = 'FTP'
  readonly capabilities: HostCapabilities = (() => {
    const set: HostCapabilities = new Set([
      Capability.ReadFile,
      Capability.WriteFile,
      Capability.WriteFileStream,
      Capability.AttachLog,
    ])
    return set
  })()

  private readonly client = new FtpClient()
  private readonly config: FtpHostConfig
  private connected = false
  private rcon: RconClient | null = null
  private ftpQueue: Promise<unknown> = Promise.resolve()
  private pollerState: PollerState | null = null

  private ftpSerialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.ftpQueue.then(op, op)
    this.ftpQueue = next.then(() => undefined, () => undefined)
    return next
  }

  constructor(config: FtpHostConfig, logger: DaemonLogger) {
    super(logger)
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
    await attachRconIfConfigured(
      this.config.rcon,
      this.config.host,
      'ftp',
      (msg) => console.error(msg),
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

  async readFile(path: string): Promise<Buffer> {
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

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    this.requireConnected('ftp')
    const source = Readable.from(typeof data === 'string' ? Buffer.from(data) : data)
    await this.client.uploadFrom(source, this.resolvePath(path))
  }

  async readFileStream(path: string): Promise<{ stream: ReadableStream<Uint8Array>; size?: number }> {
    this.requireConnected('ftp')
    return this.ftpSerialize(async () => {
      const size = await this.client.size(this.resolvePath(path))
      const node = new PassThrough()
      this.client.downloadTo(node, this.resolvePath(path)).catch((err) => {
        node.destroy(err instanceof Error ? err : new Error(String(err)))
      })
      return { stream: Readable.toWeb(node) as ReadableStream<Uint8Array>, size }
    })
  }

  async writeFileStream(path: string, _opts?: { size?: number }): Promise<WritableStream<Uint8Array>> {
    this.requireConnected('ftp')
    return this.ftpSerialize(async () => {
      const { PassThrough } = await import('node:stream')
      const node = new PassThrough()
      const web = Writable.toWeb(node) as WritableStream<Uint8Array>
      const upload = this.client.uploadFrom(node, this.resolvePath(path))
      upload.catch((err) => {
        node.destroy(err instanceof Error ? err : new Error(String(err)))
      })
      this.ftpQueue = this.ftpQueue.then(
        () => upload.then(() => undefined, () => undefined),
        () => upload.then(() => undefined, () => undefined),
      )
      return web
    })
  }

  async attachLog(onChunk: HostLogHandler): Promise<LogSubscription> {
    this.requireConnected('ftp')
    const intervalMs = this.config.pollIntervalMs ?? 500
    const logPath = this.resolvePath(this.config.logPath ?? 'logs/latest.log')

    // One polling loop shared across every attacher of this host.
    // Reference-counted: when the last handler unsubscribes the
    // timer is cleared and state reset; the next attacher starts a
    // fresh poll (seeded from the file's current size).
    let state = this.pollerState
    if (state === null) {
      state = {
        lastSize: 0,
        lastMtime: 0,
        buffer: '',
        timer: null,
        handlers: new Set<HostLogHandler>(),
      }
      this.pollerState = state

      const flushLines = () => {
        if (state === null) return
        const lines = state.buffer.split('\n')
        state.buffer = lines.pop() ?? ''
        if (lines.length > 0) {
          const ts = Date.now()
          const payload: HostLogLine[] = lines.map((line) => ({ line, ts, stream: 'stdout' }))
          for (const h of state.handlers) h(payload)
        }
      }

      const tick = async () => {
        if (state === null || state.timer === null) return
        state.timer = null
        try {
          await this.ftpSerialize(async () => {
            if (state === null) return
            const size = await this.client.size(logPath)
            const mtime = (await this.client.lastMod(logPath)).getTime()

            if (size < state.lastSize || mtime + 1000 < state.lastMtime) {
              state.lastSize = 0
              state.buffer = ''
            }

            if (size > state.lastSize) {
              let chunkBuffer = ''
              const sink = new Writable({
                write(chunk: Buffer, _enc, cb) {
                  chunkBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
                  cb()
                },
              })
              await this.client.downloadTo(sink, logPath, state.lastSize)
              state.buffer += chunkBuffer
              flushLines()
              state.lastSize = size
              state.lastMtime = mtime
            }
          })
        } catch {} finally {
          // Reset state on persistent failure so a future attach
          // retries from scratch. (One transient tick error doesn't
          // tear down the whole loop — we just reschedule.)
          if (state !== null && state.handlers.size > 0) {
            state.timer = setTimeout(tick, intervalMs)
          }
        }
      }

      // Seed initial size; on failure, leave at 0 so the first tick
      // catches up from the start of the file.
      try {
        await this.ftpSerialize(async () => {
          if (state === null) return
          state.lastSize = await this.client.size(logPath)
          state.lastMtime = (await this.client.lastMod(logPath)).getTime()
        })
      } catch {
        if (state !== null) {
          state.lastSize = 0
          state.lastMtime = 0
        }
      }
      state.timer = setTimeout(tick, intervalMs)
    }

    state.handlers.add(onChunk)
    return {
      unattach: async () => {
        if (state === null) return
        state.handlers.delete(onChunk)
        if (state.handlers.size === 0) {
          if (state.timer !== null) {
            clearTimeout(state.timer)
            state.timer = null
          }
          if (this.pollerState === state) {
            this.pollerState = null
          }
          state = null
        }
      },
    }
  }

  private requireConnected(label: string): void {
    if (!this.connected) throw new NotConnectedError(label)
  }

  private resolvePath(path: string): string {
    const base = this.config.serverPath.replace(/\/+$/, '')
    if (path.startsWith('/')) return `${base}${path}`
    return `${base}/${path}`.replace(/\/+/g, '/')
  }
}

export function createFtpHost(config: FtpHostConfig, logger: DaemonLogger): HostProvider {
  return new FtpHost(config, logger)
}

interface PollerState {
  lastSize: number
  lastMtime: number
  buffer: string
  timer: NodeJS.Timeout | null
  handlers: Set<HostLogHandler>
}