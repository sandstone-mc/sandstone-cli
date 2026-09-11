import { io as ioClient, type Socket } from 'socket.io-client'

import { HostAuthError, NotConnectedError } from '../errors.js'
import type {
  HostCapabilities,
  HostProvider,
  LogChunkHandler,
  LogSubscription,
  McsManagerHostConfig,
  ServerPath,
} from '../types.js'
import { ALL_CAPABILITIES_OFF } from '../types.js'

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
  readonly capabilities: HostCapabilities = {
    ...ALL_CAPABILITIES_OFF,
    readFile: true,
    writeFile: true,
    attachLog: true,
    executeRawCommand: true,
  }

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
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
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
      const form = new FormData()
      form.append(
        'file',
        new Blob([buffer.subarray(offset, next)], {
          type: 'application/octet-stream',
        }),
      )
      await this.api<string>(
        'upload-piece',
        { offset: `${offset}` },
        { port_override: port, path: uploadId, body: form },
      )
      offset = next
    }
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