import { Client as FtpClient } from 'basic-ftp'
import { Readable, Writable, PassThrough } from 'stream'

import { HostAuthError, NotConnectedError } from '../errors.js'
import { RconClient } from '../rcon-client.js'
import { attachRconIfConfigured } from '../_shared/attach-rcon.js'
import type { FtpHostConfig, HostCapabilities, HostProvider, HostLogLine, HostLogHandler, LogSubscription } from '../types.js'
import { Capability } from '../types.js'

export class FtpHost implements HostProvider {
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

  private ftpSerialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.ftpQueue.then(op, op)
    this.ftpQueue = next.then(() => undefined, () => undefined)
    return next
  }

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
    let lastSize = 0
    let lastMtime = 0
    let buffer = ''
    let stopped = false
    let timer: NodeJS.Timeout | null = null

    const flushLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (lines.length > 0) {
        const ts = Date.now()
        const chunks: HostLogLine[] = lines.map((line) => ({ line, ts, stream: 'stdout' }))
        onChunk(chunks)
      }
    }

    const tick = async () => {
      if (stopped) return
      try {
        await this.ftpSerialize(async () => {
          const size = await this.client.size(logPath)
          const mtime = (await this.client.lastMod(logPath)).getTime()

          if (size < lastSize || mtime + 1000 < lastMtime) {
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
            buffer += chunkBuffer
            flushLines()
            lastSize = size
            lastMtime = mtime
          }
        })
      } catch {} finally {
        if (!stopped) timer = setTimeout(tick, intervalMs)
      }
    }

    try {
      await this.ftpSerialize(async () => {
        lastSize = await this.client.size(logPath)
        lastMtime = (await this.client.lastMod(logPath)).getTime()
      })
    } catch {
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
          onChunk([{ line: buffer, ts: Date.now(), stream: 'stdout' }])
          buffer = ''
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

export function createFtpHost(config: FtpHostConfig): HostProvider {
  return new FtpHost(config)
}