import { Client as FtpClient } from 'basic-ftp'
import { Readable, Writable } from 'node:stream'

import { HostAuthError, NotConnectedError } from '../errors.js'
import { RconClient } from '../rcon-client.js'
import { attachRconIfConfigured } from '../_shared/attach-rcon.js'
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
  /**
   * FIFO queue of pending FTP control-channel operations. basic-ftp
   * can't run more than one task on its control connection at a
   * time — `await this.client.X()` while a previous `uploadFrom` /
   * `downloadTo` is still draining throws "User launched a task
   * while another one is still running". Every public method that
   * touches the FTP client goes through {@link ftpSerialize} so the
   * calls chain naturally. `writeFileStream`/`writeFile` also push
   * their upload's completion onto the queue so the next op (e.g.
   * a follow-up `readFileStream` SIZE probe) waits for the data
   * transfer to fully settle.
   */
  private ftpQueue: Promise<unknown> = Promise.resolve()

  /**
   * Run `op` after the previous FTP op completes (success OR
   * failure — we don't want a failed upload to block subsequent
   * reads forever). Returns op's promise so callers see its
   * resolution/rejection directly.
   */
  private ftpSerialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.ftpQueue.then(op, op)
    // The queue tracks completion, not op's outcome — keep the
    // chain alive even if `op` rejects.
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
    // Open RCON if configured. Same host as FTP — the MC server's
    // RCON listener binds alongside its main port.
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

  /**
   * Open a streaming read. basic-ftp's `downloadTo(sink, path)`
   * writes into a sink but doesn't yield chunks as they arrive from
   * the FTP data connection. Wrap it with a `PassThrough` converted
   * to a web `ReadableStream` so the daemon can consume chunks
   * lazily. `size` is best-effort via the SIZE command.
   */
  async readFileStream(path: ServerPath): Promise<{ stream: ReadableStream<Uint8Array>; size?: number }> {
    this.requireConnected('ftp')
    return this.ftpSerialize(async () => {
      const { PassThrough } = await import('node:stream')
      // Fast-fail on a missing file (550). Pressing on to
      // `downloadTo` would trigger another 550 mid-stream AND
      // basic-ftp's internal `_onControlSocketData` emits an
      // `'error'` event we can't intercept cleanly — we'd surface
      // a useless unhandled rejection that no consumer can act
      // on. Propagate the size() failure so the dispatch handler
      // returns an RPC error and the client sees the clean
      // failure immediately.
      const size = await this.client.size(this.resolvePath(path))
      const node = new PassThrough()
      // Fire-and-forget — `sink` is the stream the daemon consumes.
      this.client.downloadTo(node, this.resolvePath(path)).catch((err) => {
        node.destroy(err instanceof Error ? err : new Error(String(err)))
      })
      return { stream: Readable.toWeb(node) as ReadableStream<Uint8Array>, size }
    })
  }

  /**
   * Open a streaming write. basic-ftp's `uploadFrom(source, path)`
   * accepts a `Readable`. Wrap a `PassThrough` converted to a web
   * `WritableStream` so the daemon can pipe chunks into it via the
   * Web Streams API.
   *
   * `opts.size` is ignored — basic-ftp's `uploadFrom` is a true
   * streaming sink, so the file size doesn't need to be known up
   * front.
   */
  async writeFileStream(path: ServerPath, _opts?: { size?: number }): Promise<WritableStream<Uint8Array>> {
    this.requireConnected('ftp')
    return this.ftpSerialize(async () => {
      const { PassThrough } = await import('node:stream')
      const node = new PassThrough()
      const web = Writable.toWeb(node) as WritableStream<Uint8Array>
      const upload = this.client.uploadFrom(node, this.resolvePath(path))
      upload.catch((err) => {
        node.destroy(err instanceof Error ? err : new Error(String(err)))
      })
      // Block subsequent FTP ops until this upload settles —
      // basic-ftp can't run a second task while the upload's data
      // channel + control channel are still being torn down. We
      // return the web stream to the caller immediately so the
      // dispatch can return the streamId, but the queue waits
      // for `upload` to resolve.
      this.ftpQueue = this.ftpQueue.then(
        () => upload.then(() => undefined, () => undefined),
        () => upload.then(() => undefined, () => undefined),
      )
      return web
    })
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
        // Wrap the whole tick in ftpSerialize so a concurrent
        // read/write op on the host can't race the poll — basic-ftp
        // can't run two tasks on the control channel at once.
        await this.ftpSerialize(async () => {
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
        })
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
      await this.ftpSerialize(async () => {
        lastSize = await this.client.size(logPath)
        lastMtime = (await this.client.lastMod(logPath)).getTime()
      })
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