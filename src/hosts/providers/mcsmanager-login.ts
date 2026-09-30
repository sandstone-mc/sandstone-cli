import { io as ioClient, type Socket } from 'socket.io-client'

import { HostAuthError, NotConnectedError } from '../errors.js'
import { Capability, type HostCapabilities, type HostProvider, type LogChunkHandler, type LogSubscription, type McsManagerHostConfig, type ServerPath } from '../types.js'

/**
 * MCSManager provider — web-panel Login API variant. Cookie + session-
 * token auth via `/api/auth/login`. Files via the chunked-upload REST
 * protocol; logs and commands via a `socket.io-client` connection to
 * the panel's daemon WS (port 24444 by default).
 *
 * NOT the API-key variant — MCSManager also exposes an API-key style
 * protocol that a separate provider will implement later. The `-login`
 * suffix here exists to keep that future file from needing to rename
 * this one.
 *
 * Direct port of `.temp/mcsmanager-login-deploy.ts`. Differences from the
 * legacy script:
 *  - No `.env` writes. Callers persist the session themselves if needed.
 *  - Auth state is per-instance (the legacy script used module globals).
 *  - `executeRawCommand` buffers a brief post-emit window of stdout and
 *    returns it; matches RCON's "give back what the server said" contract.
 */

interface FileUploadResponse {
  status: number
  time: number
  data: { password: string; addr: `localhost:${number}` }
}
interface UploadNewResponse {
  status: number
  data: { id: string }
}
interface FileDownloadResponse {
  status: number
  data: { password: string; addr: string }
}
interface StreamChannelResponse {
  status: number
  data: { password: string; addr: string; prefix: string; remoteMappings?: unknown[] }
  time: number
}

export class McsManagerLoginHost implements HostProvider {
  readonly type = 'mcsmanager-login' as const
  readonly displayName = 'MCSManager (Login)'
  readonly capabilities: HostCapabilities = new Set([
    Capability.ReadFile,
    Capability.WriteFile,
    Capability.AttachLog,
    Capability.ExecuteRawCommand,
    Capability.ExecuteRawCommandHasResponse,
  ])

  private readonly config: McsManagerHostConfig
  private cookie = ''
  private token = ''
  private socket: Socket | null = null
  private connected = false

  // Track every attachLog subscription so disconnect can clean up listeners.
  private stdoutSubscriptions: Array<{
    handler: (packet: { data?: { text?: string } }) => void
    socket: Socket
  }> = []

  /**
   * Set of liveness-loss listeners. Fired when the panel's daemon WS
   * drops or fails to handshake — NOT for our own `disconnect()`
   * call. The daemon subscribes via {@link HostProvider.onDisconnected}
   * to detect when a composite member has gone away and trigger a
   * coordinated shutdown.
   */
  disconnectHandlers: Set<(reason: string) => void> = new Set<(reason: string) => void>()

  constructor(config: McsManagerHostConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.connected) return
    // Seed session from env if present; otherwise force a login.
    this.cookie = process.env.MCS_MANAGER_COOKIE ?? ''
    this.token = process.env.MCS_MANAGER_TOKEN ?? ''
    await this.login()
    this.connected = true
    // RCON target is the panel-managed daemon's local socket. We
    // can't use the shared `attachRconIfConfigured` here because
    // mcsmanager's RCON host string is a constructor-time concern
    // (`config.endpoint`) and `attachRconIfConfigured` would bind it
    // to `config.host`. For now we leave the legacy in-place RCON
    // path — `executeRawCommand` is rarely used against panel
    // sockets.
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    // Detach the disconnect-listener set BEFORE killing so the close
    // event fired by our own disconnect doesn't trigger our own handler.
    this.disconnectHandlers.clear()
    // Drop all attachLog listeners on their respective sockets.
    for (const sub of this.stdoutSubscriptions) {
      sub.socket.off('instance/stdout', sub.handler)
    }
    this.stdoutSubscriptions = []
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  /**
   * Whether the panel-managed MC server is reachable — true while
   * we have a live authenticated session with the panel.
   */
  isRunning(): boolean {
    return this.connected && this.socket?.connected === true
  }

  /**
   * Subscribe to panel-side WS liveness loss. Returns an unsubscribe
   * function. The daemon uses this to detect when a composite member
   * has gone away and trigger a coordinated shutdown.
   */
  onDisconnected(handler: (reason: string) => void): () => void {
    this.disconnectHandlers.add(handler)
    return () => {
      this.disconnectHandlers.delete(handler)
    }
  }

  async readFile(path: ServerPath): Promise<Buffer> {
    this.requireConnected('mcsmanager-login')
    const dl = await this.api<FileDownloadResponse>('files/download', { file_name: path })
    if (dl.status !== 200 || !dl.data?.password) {
      throw new Error(`MCSManager download failed: ${JSON.stringify(dl)}`)
    }
    const host = new URL(this.config.endpoint).hostname
    const port = dl.data.addr.split(':')[1]
    const url = `http://${host}:${port}/download/${dl.data.password}/${path}`
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new Error(`MCSManager download HTTP ${resp.status}`)
    }
    const ab = await resp.arrayBuffer()
    return Buffer.from(ab)
  }

  /**
   * Streaming read. Uses the same `files/download` handshake as the
   * buffering variant, then returns the HTTP response body directly —
   * `fetch()` already exposes the body as a `ReadableStream<Uint8Array>`
   * so chunks flow as the panel's download endpoint ships them.
   *
   * Size comes from `Content-Length` when the panel sets it; the
   * daemon's dispatch surface ignores `undefined` so callers that
   * need progress can fall back to byte counting.
   */
  async readFileStream(path: ServerPath): Promise<{ stream: ReadableStream<Uint8Array>; size?: number }> {
    this.requireConnected('mcsmanager-login')
    const dl = await this.api<FileDownloadResponse>('files/download', { file_name: path })
    if (dl.status !== 200 || !dl.data?.password) {
      throw new Error(`MCSManager download failed: ${JSON.stringify(dl)}`)
    }
    const host = new URL(this.config.endpoint).hostname
    const port = dl.data.addr.split(':')[1]
    const url = `http://${host}:${port}/download/${dl.data.password}/${path}`
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new Error(`MCSManager download HTTP ${resp.status}`)
    }
    const sizeHeader = resp.headers.get('content-length')
    const size = sizeHeader ? Number(sizeHeader) : undefined
    if (!resp.body) {
      throw new Error(`MCSManager download returned no body`)
    }
    return { stream: resp.body as ReadableStream<Uint8Array>, size }
  }

  async writeFile(path: ServerPath, data: Buffer | string): Promise<void> {
    this.requireConnected('mcsmanager-login')
    const buffer = typeof data === 'string' ? Buffer.from(data) : data
    const filename = path.replace(/^.*\//, '')
    const uploadStart = await this.api<FileUploadResponse>('files/upload', {
      file_name: filename,
      upload_dir: path.replace(/[^/]+$/, ''),
    })
    const port = uploadStart.data.addr.split(':')[1] as `${number}`

    const meta = await this.api<UploadNewResponse>(
      'upload-new',
      {
        filename,
        overwrite: 'true',
        size: `${buffer.byteLength}`,
        sum: '',
      },
      { port_override: port, path: uploadStart.data.password },
    )

    await this.uploadChunks(meta.data.id, port, buffer)
  }

  /**
   * Streaming write. Two paths:
   *
   *  - **Size known** (`opts.size !== undefined`): call `upload-new`
   *    up front with the declared size, then ship each arriving
   *    chunk as an `upload-piece` request. True end-to-end
   *    streaming — nothing is buffered beyond the per-chunk upload
   *    in flight.
   *
   *  - **Size unknown**: MCSManager's chunked-upload protocol
   *    requires the total size up front in `upload-new`, which the
   *    streaming shape can't provide. Accept the WritableStream API
   *    (consumers see the same one-chunk-at-a-time flow as every
   *    other host) but buffer internally until `close()` fires, then
   *    run the existing chunked upload. Memory cost is the file
   *    size — bounded by the host's available heap.
   */
  async writeFileStream(path: ServerPath, opts?: { size?: number }): Promise<WritableStream<Uint8Array>> {
    this.requireConnected('mcsmanager-login')
    const filename = path.replace(/^.*\//, '')
    const uploadDir = path.replace(/[^/]+$/, '')
    const uploadStart = await this.api<FileUploadResponse>('files/upload', {
      file_name: filename,
      upload_dir: uploadDir,
    })
    const port = uploadStart.data.addr.split(':')[1] as `${number}`
    const uploadPath = uploadStart.data.password

    if (opts?.size !== undefined) {
      // True streaming — register the upload up front, then coalesce
      // arriving chunks into PIECE_SIZE pieces and ship each via
      // `upload-piece`. Matches the chunked-upload protocol the
      // panel expects (the buffered `writeFile` path uses the same
      // size in `uploadChunks`).
      const meta = await this.api<UploadNewResponse>(
        'upload-new',
        {
          filename,
          overwrite: 'true',
          size: `${opts.size}`,
          sum: '',
        },
        { port_override: port, path: uploadPath },
      )
      const uploadId = meta.data.id
      const expectedSize = opts.size
      // Same chunk size as the buffered `uploadChunks` loop — keeps
      // the panel-side behaviour consistent for both code paths.
      const PIECE_SIZE = 2_097_374
      let offset = 0
      let pending: Uint8Array[] = []
      let pendingBytes = 0
      const host = this
      return new WritableStream<Uint8Array>({
        async write(chunk) {
          pending.push(chunk)
          pendingBytes += chunk.byteLength
          // Drain full pieces; keep the tail (< PIECE_SIZE) for
          // the next write() / close().
          while (pendingBytes >= PIECE_SIZE) {
            const merged = Buffer.concat(pending, pendingBytes)
            const take = merged.subarray(0, PIECE_SIZE)
            await host.uploadChunk(uploadId, port, offset, take)
            offset += PIECE_SIZE
            const tail = merged.subarray(PIECE_SIZE)
            pending = tail.byteLength > 0 ? [tail] : []
            pendingBytes = tail.byteLength
          }
        },
        async close() {
          if (pendingBytes > 0) {
            const tail = Buffer.concat(pending, pendingBytes)
            await host.uploadChunk(uploadId, port, offset, tail)
            offset += tail.byteLength
          }
          if (offset !== expectedSize) {
            throw new Error(
              `MCSManager upload size mismatch: wrote ${offset}, expected ${expectedSize}`,
            )
          }
        },
      })
    }

    // Buffer fallback (no size known up front).
    const chunks: Uint8Array[] = []
    let totalSize = 0
    const host = this
    return new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk)
        totalSize += chunk.byteLength
      },
      async close() {
        const buffer = Buffer.concat(chunks, totalSize)
        const meta = await host.api<UploadNewResponse>(
          'upload-new',
          {
            filename,
            overwrite: 'true',
            size: `${buffer.byteLength}`,
            sum: '',
          },
          { port_override: port, path: uploadPath },
        )
        await host.uploadChunks(meta.data.id, port, buffer)
      },
      abort() {
        // Drop the buffered chunks — consumer cancelled before close.
        chunks.length = 0
      },
    })
  }

  async attachLog(onChunk: LogChunkHandler): Promise<LogSubscription> {
    this.requireConnected('mcsmanager-login')
    const sock = await this.openDaemonSocket()
    let buffer = ''
    let stopped = false

    const handler = (packet: { data?: { text?: string } }) => {
      if (stopped) return
      const text = packet?.data?.text ?? ''
      if (!text) return
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (lines.length > 0) onChunk(lines)
    }

    sock.on('instance/stdout', handler)
    this.stdoutSubscriptions.push({ handler, socket: sock })

    const self = this
    return {
      async unattach() {
        if (stopped) return
        stopped = true
        sock.off('instance/stdout', handler)
        self.stdoutSubscriptions = self.stdoutSubscriptions.filter(
          (s) => s.handler !== handler,
        )
        if (buffer.length > 0) {
          onChunk([buffer])
          buffer = ''
        }
      },
    }
  }

  async executeRawCommand(command: string): Promise<string> {
    this.requireConnected('mcsmanager-login')
    const sock = await this.openDaemonSocket()
    let captured = ''
    const handler = (packet: { data?: { text?: string } }) => {
      const text = packet?.data?.text ?? ''
      if (text) captured += text
    }
    sock.on('instance/stdout', handler)
    sock.emit('stream/input', { data: { command } })
    // Buffer ~1.5s of post-emit stdout. Fabric doesn't echo mc console
    // commands, but MCSManager's daemon forwards `say`/`tellraw` and
    // command outputs back as stdout events.
    await new Promise((r) => setTimeout(r, 1500))
    sock.off('instance/stdout', handler)
    return captured.trim()
  }

  // ---------------------------------------------------------------------

  private requireConnected(label: string): void {
    if (!this.connected) throw new NotConnectedError(label)
  }

  /**
   * Login via the panel's `/api/auth/login`. Throws HostAuthError on
   * failure. Mutates `cookie` and `token` on success.
   */
  private async login(): Promise<void> {
    const username =
      this.config.username ?? process.env.MCS_MANAGER_USERNAME
    const passwordB64 =
      this.config.password ?? process.env.MCS_MANAGER_PASSWORD
    if (!username || !passwordB64) {
      throw new HostAuthError(
        'MCSManager login requires username + password (config or MCS_MANAGER_USERNAME / MCS_MANAGER_PASSWORD env)',
      )
    }
    const password = Buffer.from(passwordB64, 'base64').toString('utf8')

    const url = new URL(this.config.endpoint)
    url.pathname = '/api/auth/login'
    url.search = ''

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: url.origin,
        Referer: url.origin + '/',
      },
      body: JSON.stringify({ username, password, code: '' }),
    })
    const body = (await resp.json().catch(() => null)) as
      | { status?: number; data?: string }
      | null
    if (
      !resp.ok ||
      body?.status !== 200 ||
      !body.data
    ) {
      throw new HostAuthError(
        `MCSManager login failed (HTTP ${resp.status})`,
      )
    }

    const setCookies =
      (resp.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    if (setCookies.length < 2) {
      throw new HostAuthError(
        `MCSManager login returned ${setCookies.length} Set-Cookie headers (expected 2)`,
      )
    }
    this.cookie = setCookies.map((c) => c.split(';')[0].trim()).join('; ')
    this.token = body.data
  }

  private async api<T>(
    route: string,
    params: Record<string, string>,
    options?: {
      body?: unknown
      path?: string
      method?: 'POST' | 'OPTIONS'
      port_override?: `${number}`
    },
  ): Promise<T> {
    const url = new URL(this.config.endpoint)
    if (options?.port_override) {
      url.port = options.port_override
      url.pathname = '/'
    }
    const doRequest = async () =>
      await fetch(
        `${url}${route}${
          options?.path === undefined ? '' : `/${options.path}`
        }?${new URLSearchParams({
          ...params,
          token: this.token,
          uuid: this.config.uuid,
          daemonId: this.config.daemonId,
        })}`,
        {
          method: options?.method ?? 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: this.cookie,
          },
          ...(options?.body === undefined
            ? {}
            : { body: options.body as RequestInit['body'] }),
        },
      )

    let response = await doRequest()
    this.syncSessionFromResponse(response)
    if (response.status === 403) {
      await this.login()
      response = await doRequest()
      this.syncSessionFromResponse(response)
    }

    const bodyText = await response.text()
    if (bodyText === 'OK') return 'OK' as unknown as T
    try {
      return JSON.parse(bodyText) as T
    } catch {
      throw new Error(
        `MCSManager ${route} returned non-JSON: ${bodyText.slice(0, 200)}`,
      )
    }
  }

  private syncSessionFromResponse(response: Response): void {
    const setCookies =
      (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    if (setCookies.length < 2) return
    const newCookie = setCookies.map((c) => c.split(';')[0].trim()).join('; ')
    const newToken = this.parseSessionToken(newCookie)
    if (!newToken) return
    this.cookie = newCookie
    this.token = newToken
  }

  private parseSessionToken(cookieStr: string): string | null {
    const first = cookieStr.split(';')[0]?.trim() ?? ''
    const eq = first.indexOf('=')
    if (eq < 0) return null
    try {
      const json = JSON.parse(
        Buffer.from(first.slice(eq + 1), 'base64').toString('utf8'),
      ) as { token?: string }
      return typeof json.token === 'string' ? json.token : null
    } catch {
      return null
    }
  }

  private async uploadChunks(
    uploadId: string,
    port: `${number}`,
    buffer: Buffer,
  ): Promise<void> {
    let offset = 0
    while (offset !== buffer.byteLength) {
      const next = Math.min(offset + 2_097_374, buffer.byteLength)
      await this.uploadChunk(uploadId, port, offset, buffer.subarray(offset, next))
      offset = next
    }
  }

  /**
   * Single-piece `upload-piece` request. Used by both the streaming
   * `writeFileStream` (one call per arriving chunk) and the
   * buffered variant (chunked loop in {@link uploadChunks}).
   */
  private async uploadChunk(
    uploadId: string,
    port: `${number}`,
    offset: number,
    chunk: Uint8Array,
  ): Promise<void> {
    const form = new FormData()
    form.append(
      'file',
      new Blob([chunk], { type: 'application/octet-stream' }),
    )
    await this.api<string>(
      'upload-piece',
      { offset: `${offset}` },
      { port_override: port, path: uploadId, body: form },
    )
  }

  /**
   * Open the daemon WebSocket if not already open, authenticate via
   * `stream/auth`, and return the connected socket.
   */
  private async openDaemonSocket(): Promise<Socket> {
    if (this.socket?.connected) return this.socket
    const channel = await this.api<StreamChannelResponse>(
      'protected_instance/stream_channel',
      {
        daemonId: this.config.daemonId,
        uuid: this.config.uuid,
      },
    )
    if (channel.status !== 200 || !channel.data) {
      throw new Error(
        `MCSManager stream_channel error: ${JSON.stringify(channel)}`,
      )
    }
    const daemonUrl = `ws://${new URL(this.config.endpoint).hostname}:24444`
    const sock = ioClient(daemonUrl, {
      transports: ['websocket'],
      path: (channel.data.prefix ? channel.data.prefix.replace(/\/$/, '') : '') + '/socket.io',
    })

    // Fire the onDisconnected handlers whenever the panel's WS dies
    // or the initial handshake fails. The daemon's composite-shutdown
    // path subscribes to this so an `[ftp, mcsmanager-login]`
    // composite doesn't keep trying to dispatch into a dead socket.
    sock.on('disconnect', (reason: string) => {
      for (const h of this.disconnectHandlers) h(`MCSManager daemon disconnected: ${reason}`)
    })
    sock.on('connect_error', (err: Error) => {
      for (const h of this.disconnectHandlers) h(`MCSManager daemon connect_error: ${err.message}`)
    })

    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve())
      sock.once('connect_error', (err: Error) => reject(err))
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('MCSManager stream/auth timeout')),
        5_000,
      )
      sock.once('stream/auth', (packet: { status?: number; data?: boolean }) => {
        clearTimeout(timer)
        if (packet?.status === 200 && packet?.data === true) resolve()
        else reject(new Error('MCSManager stream/auth failed'))
      })
      sock.emit('stream/auth', { data: { password: channel.data.password } })
    })
    this.socket = sock
    return sock
  }
}

// Reference for the panel's response contracts is now expressed via the
// typed `FileDownloadResponse` / `FileUploadResponse` / etc. interfaces at
// the top of the file.

/** Factory used by the registry. */
export function createMcsManagerHost(config: McsManagerHostConfig): HostProvider {
  return new McsManagerLoginHost(config)
}