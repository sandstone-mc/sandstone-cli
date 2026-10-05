import { io as ioClient } from 'socket.io-client'

import { HostAuthError, NotConnectedError } from '../errors.js'
import { HostProvider, Capability } from '../types.js'

import type { Socket } from 'socket.io-client'
import type { DaemonLogger, McsManagerHostConfig, HostCapabilities, HostLogLine, HostLogHandler, LogSubscription } from '../types.js'

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

export class McsManagerLoginHost extends HostProvider {
  readonly type = 'mcsmanager-login' as const
  readonly displayName = 'MCSManager (Login)'
  readonly capabilities: HostCapabilities = new Set([
    Capability.ReadFile,
    Capability.WriteFile,
    Capability.WriteFileStream,
    Capability.AttachLog,
    Capability.ExecuteRawCommand,
  ])

  private readonly config: McsManagerHostConfig
  private cookie = ''
  private token = ''
  private socket: Socket | null = null
  private connected = false
  private stdoutState: StdoutState | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly RECONNECT_INTERVAL_MS = 15_000
  private static readonly DISCONNECT_GRACE_MS = 30 * 60 * 1000

  disconnectHandlers: Set<(reason: string) => void> = new Set<(reason: string) => void>()

  constructor(config: McsManagerHostConfig, logger: DaemonLogger) {
    super(logger)
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.connected) return
    this.cookie = process.env.MCS_MANAGER_COOKIE ?? ''
    this.token = process.env.MCS_MANAGER_TOKEN ?? ''
    await this.login()
    try {
      await this.openDaemonSocket()
    } catch (err) {
      this.socket?.disconnect()
      this.socket = null
      this.connected = false
      throw new HostAuthError(
        err instanceof Error ? `MCSManager daemon socket unavailable: ${err.message}` : 'MCSManager daemon socket unavailable',
      )
    }
    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    this.disconnectHandlers.clear()
    this.clearReconnect()
    this.clearDisconnectGrace()
    if (this.stdoutState !== null) {
      this.stdoutState.socket.off('instance/stdout', this.stdoutState.listener)
      this.stdoutState = null
    }
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  isRunning(): boolean {
    return this.connected && this.socket?.connected === true
  }

  onDisconnected(handler: (reason: string) => void): () => void {
    this.disconnectHandlers.add(handler)
    return () => {
      this.disconnectHandlers.delete(handler)
    }
  }

  async readFile(path: string): Promise<Buffer> {
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

  async readFileStream(path: string): Promise<{ stream: ReadableStream<Uint8Array>; size?: number }> {
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

  async writeFile(path: string, data: Buffer | string): Promise<void> {
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

  async writeFileStream(path: string, opts?: { size?: number }): Promise<WritableStream<Uint8Array>> {
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
      const PIECE_SIZE = 2_097_374
      let offset = 0
      let pending: Uint8Array[] = []
      let pendingBytes = 0
      const host = this
      return new WritableStream<Uint8Array>({
        async write(chunk) {
          pending.push(chunk)
          pendingBytes += chunk.byteLength

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
        chunks.length = 0
      },
    })
  }

  async attachLog(onChunk: HostLogHandler): Promise<LogSubscription> {
    this.requireConnected('mcsmanager-login')
    if (this.socket?.connected !== true) {
      throw new Error('MCSManager daemon socket is currently down — wait at least 15 seconds before retrying (auto-reconnecting in the background)')
    }

    let state = this.stdoutState
    if (state === null) {
      const listener = (packet: { data?: { text?: string } }) => {
        if (state === null) return
        const text = packet?.data?.text ?? ''
        if (!text) return
        state.buffer += text
        const lines = state.buffer.split('\n')
        state.buffer = lines.pop() ?? ''
        if (lines.length > 0) {
          const ts = Date.now()
          const payload: HostLogLine[] = lines.map((line) => ({ line, ts, stream: 'stdout' }))
          for (const h of state.handlers) h(payload)
        }
      }
      state = { socket: this.socket, listener, buffer: '', handlers: new Set<HostLogHandler>() }
      this.stdoutState = state
      this.socket.on('instance/stdout', listener)
    }

    state.handlers.add(onChunk)
    return {
      unattach: async () => {
        if (state === null) return
        state.handlers.delete(onChunk)
        if (state.handlers.size === 0) {
          state.socket.off('instance/stdout', state.listener)
          if (this.stdoutState === state) {
            this.stdoutState = null
          }
          state = null
        }
      },
    }
  }

  async executeRawCommand(command: string): Promise<undefined> {
    this.requireConnected('mcsmanager-login')
    if (this.socket?.connected !== true) {
      throw new Error('MCSManager daemon socket is currently down — wait at least 15 seconds before retrying (auto-reconnecting in the background)')
    }
    this.socket.emit('stream/input', { data: { command } })
    return undefined
  }

  private requireConnected(label: string) {
    if (!this.connected) throw new NotConnectedError(label)
  }

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

  private syncSessionFromResponse(response: Response) {
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
    sock.on('disconnect', (reason: string) => {
      if (this.socket === sock) this.socket = null
      if (this.stdoutState !== null && this.stdoutState.socket === sock) {
        this.stdoutState = null
      }
      console.error(`[mcsmanager] daemon disconnected: ${reason}`)
      this.armDisconnectGrace()
      this.scheduleReconnect()
    })
    sock.on('connect_error', (err: Error) => {
      console.error(`[mcsmanager] daemon connect_error: ${err.message}`)
      this.armDisconnectGrace()
      this.scheduleReconnect()
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

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return
    if (!this.connected) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.connected) return
      this.openDaemonSocket().then(() => this.clearDisconnectGrace()).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[mcsmanager] daemon reconnect failed: ${msg}`)
        this.scheduleReconnect()
      })
    }, McsManagerLoginHost.RECONNECT_INTERVAL_MS)
  }

  private clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private armDisconnectGrace() {
    if (this.disconnectGraceTimer !== null) return
    if (!this.connected) return
    this.disconnectGraceTimer = setTimeout(() => {
      this.disconnectGraceTimer = null
      // Grace expired — give up and let `sand connect` shut down.
      console.error(`[mcsmanager] daemon unreachable for ${McsManagerLoginHost.DISCONNECT_GRACE_MS / 1000}s, reporting host lost`)
      for (const h of this.disconnectHandlers) h('MCSManager daemon unreachable')
    }, McsManagerLoginHost.DISCONNECT_GRACE_MS)
  }

  private clearDisconnectGrace() {
    if (this.disconnectGraceTimer !== null) {
      clearTimeout(this.disconnectGraceTimer)
      this.disconnectGraceTimer = null
    }
  }
}

export function createMcsManagerHost(config: McsManagerHostConfig, logger: DaemonLogger): HostProvider {
  return new McsManagerLoginHost(config, logger)
}

interface StdoutState {
  socket: Socket
  listener: (packet: { data?: { text?: string } }) => void
  buffer: string
  handlers: Set<HostLogHandler>
}