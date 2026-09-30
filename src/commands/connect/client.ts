/**
 * Minimal WebSocket client for the `sand connect` daemon.
 *
 * Wire protocol is msgpack-encoded JSON-RPC envelopes + binary
 * stream-chunk frames (16-byte streamId + payload). Every RPC and
 * event rides on the same single WS; only the chunk frames use a
 * separate encoding.
 */
import type * as rpc from './rpc.js'
import { classifyWsMessage } from './rpc.js'
import { SUBPROTOCOL_PREFIX } from './rpc.js'
import type { ActiveSaveConfig } from '../../utils/activeSaveConfig.js'
import type { EndpointFile } from './endpoint-file.js'
import {
  decodeRpc,
  decodeStreamChunk,
  encodeRpc,
  encodeStreamChunk,
  hexFromBytes,
  hexToBytes,
  STREAM_MAGIC,
} from './codec.js'

export interface AttachLogSubscription {
  readonly subscriptionId: string
  onLines(fn: (lines: string[]) => void): void
  unattach(): Promise<void>
}

export interface ClientOptions {
  endpoint: EndpointFile
  /** Defaults to 30s. */
  requestTimeoutMs?: number
}
export interface ReadFileStreamResult {
  streamId: string
  stream: ReadableStream<Uint8Array>
  totalSize?: number
  done: Promise<{ bytesRead: number }>
}
export interface WriteFileStreamResult {
  streamId: string
  done: Promise<{ bytesWritten: number }>
}

type InternalListener = (lines: string[]) => void
type StreamRecord = {
  streamId: string
  /** Inbound only; undefined for outbound (writeFile) streams. */
  controller?: ReadableStreamDefaultController<Uint8Array>
  resolve: (bytes: number) => void
  reject: (err: Error) => void
}
type PendingEntry = { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

type ConfigChangedEvent = {
  saveConfig: ActiveSaveConfig | undefined
  mode: 'pack' | 'library'
  configPath: string
  detectedAt: string
}

type FallbackNotificationHandler = (notif: { method: string; params?: unknown }) => Promise<void> | void

export class Client {
  readonly welcome: rpc.WelcomeEvent
  private readonly ws: WebSocket
  private readonly timeoutMs: number
  private readonly pending = new Map<string | number, PendingEntry>()
  private readonly listenersBySub = new Map<string, Set<InternalListener>>()
  private readonly streamsById = new Map<string, StreamRecord>()
  private readonly shutdownHandlers = new Set<(reason: string) => void>()
  private readonly configChangedHandlers = new Set<(event: ConfigChangedEvent) => void>()
  private readonly triggerHandlers = new Set<(event: rpc.TriggerBuildEvent) => void>()
  private fallbackNotificationHandler: FallbackNotificationHandler | undefined
  private nextId = 1
  private closed = false

  private constructor(ws: WebSocket, welcome: rpc.WelcomeEvent, timeoutMs: number) {
    this.ws = ws
    this.welcome = welcome
    this.timeoutMs = timeoutMs
  }

  /** Open WS, await welcome, return ready Client. */
  static async open(opts: ClientOptions): Promise<Client> {
    const ws = new WebSocket(opts.endpoint.url, [SUBPROTOCOL_PREFIX + opts.endpoint.secret])
    const timeoutMs = opts.requestTimeoutMs ?? 30_000

    const welcome = await new Promise<rpc.WelcomeEvent>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('welcome timed out')), timeoutMs)
      const onWelcomeMessage = (ev: MessageEvent) => {
        let parsed: unknown
        try { parsed = decodeRpc(Bytes(ev.data)).value } catch {
          return
        }
        if (parsed && typeof parsed === 'object' && 'event' in parsed && (parsed as { event: unknown }).event === 'welcome') {
          clearTimeout(t)
          ws.removeEventListener('message', onWelcomeMessage)
          resolve((parsed as unknown as { data: rpc.WelcomeEvent }).data)
        }
      }
      ws.addEventListener('message', onWelcomeMessage)
    })

    const client = new Client(ws, welcome, timeoutMs)
    ws.addEventListener('message', (ev) => client.handleMessage(ev))
    ws.addEventListener('close', () => client.handleClose())
    return client
  }

  private handleMessage(ev: MessageEvent): void {
    const buf = Bytes(ev.data)
    if (typeof ev.data !== 'string' && buf.byteLength >= 17 && buf[0] === STREAM_MAGIC) {
      const { streamId, chunk } = decodeStreamChunk(buf)
      const record = this.streamsById.get(hexFromBytes(streamId))!
      record.controller!.enqueue(chunk)
      return
    }
    const msg = classifyWsMessage(buf)
    if (!msg) return

    switch (msg.kind) {
      case 'response': {
        const handler = this.pending.get(msg.id)
        if (!handler) return
        this.pending.delete(msg.id)
        clearTimeout(handler.timer)
        if (msg.error) handler.reject(rpcErrorToException(msg.error))
        else handler.resolve(msg.result)
        return
      }
      case 'event': {
        switch (msg.event) {
          case 'log': {
            const logData = msg.data as { subscriptionId: string; lines: string[] }
            const subs = this.listenersBySub.get(logData.subscriptionId)
            if (subs) for (const fn of subs) fn(logData.lines)
            return
          }
          case 'daemonShutdown': {
            const reason = (msg.data as { reason?: string } | undefined)?.reason ?? 'unknown'
            for (const { reject, timer } of this.pending.values()) {
              clearTimeout(timer)
              reject(new Error('daemon shutting down'))
            }
            this.pending.clear()
            for (const h of this.shutdownHandlers) {
              try { h(reason) } catch { /* swallow */ }
            }
            this.shutdownHandlers.clear()
            this.closed = true
            try {
              this.ws.close(1001, 'daemon shutting down')
            } catch {
              // already closed / never opened
            }
            return
          }
          case 'configChanged':
            for (const h of this.configChangedHandlers) {
              try {
                h(msg.data as ConfigChangedEvent)
              } catch { /* swallow */ }
            }
            return
          case 'triggerBuild':
            for (const h of this.triggerHandlers) {
              try { h(msg.data as rpc.TriggerBuildEvent) } catch { /* swallow */ }
            }
            return
          case 'streamEnd': {
            const data = msg.data as { streamId: string; bytes: number }
            const record = this.streamsById.get(data.streamId)
            if (record) {
              if (record.controller) {
                try { record.controller.close() } catch { /* already closed */ }
              }
              record.resolve(data.bytes)
              this.streamsById.delete(data.streamId)
            }
            return
          }
          case 'streamError': {
            const data = msg.data as { streamId: string; code: number; message: string }
            const record = this.streamsById.get(data.streamId)
            if (record) {
              const err = new Error(data.message)
              this.streamsById.delete(data.streamId)
              queueMicrotask(() => {
                if (record.controller) {
                  try { record.controller.error(err) } catch { /* already closed */ }
                } else {
                  record.reject(err)
                }
              })
            }
            return
          }
          default:
            if (this.fallbackNotificationHandler) {
              Promise.resolve(this.fallbackNotificationHandler({ method: msg.event, params: msg.data })).catch(() => {})
            }
            return
        }
      }
      case 'notification': {
        if (this.fallbackNotificationHandler) {
          Promise.resolve(this.fallbackNotificationHandler({ method: msg.method, params: msg.params })).catch(() => {})
        }
        return
      }
      case 'request': {
        return
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('connection closed'))
    }
    this.pending.clear()
    for (const [id, record] of this.streamsById) {
      if (record.controller) {
        try { record.controller.error(new Error('connection closed')) } catch { /* ignore */ }
      }
      record.reject(new Error('connection closed'))
      this.streamsById.delete(id)
    }
  }

  private call<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'))
    const id = this.nextId++
    const req: rpc.RpcRequest = { id, method: method as rpc.RpcMethod, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc '${method}' timed out`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer })
      this.ws.send(encodeRpc(req))
    })
  }

  private buildSingle(subscriptionId: string): AttachLogSubscription {
    let detached = false
    const set = new Set<InternalListener>()
    this.listenersBySub.set(subscriptionId, set)
    const self = this
    return {
      subscriptionId,
      onLines(fn: (lines: string[]) => void) {
        set.add((lines) => fn(lines))
      },
      async unattach() {
        if (detached) return
        detached = true
        self.listenersBySub.delete(subscriptionId)
        try {
          await self.call<void>('unattach', { subscriptionId })
        } catch {}
      },
    }
  }

  private openInboundStream(args: {
    streamId: string
    rpcResolve: (result: unknown) => void
    rpcReject: (err: Error) => void
  }): { stream: ReadableStream<Uint8Array>; done: Promise<{ bytesRead: number }> } {
    const streamId = args.streamId
    const self = this
    let resolveDone!: (b: { bytesRead: number }) => void
    let rejectDone!: (err: Error) => void
    const done = new Promise<{ bytesRead: number }>((res, rej) => {
      resolveDone = res
      rejectDone = rej
    })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const record: StreamRecord = {
          streamId,
          controller,
          resolve(bytes: number) {
            args.rpcResolve(undefined)
            // `streamEnd` is handled by the dispatcher and will also
            // call resolveDone. Defer the done resolution here to a
            // microtask so the caller sees the RPC resolve first.
            queueMicrotask(() => resolveDone({ bytesRead: bytes }))
          },
          reject(err: Error) {
            args.rpcReject(err)
            rejectDone(err)
          },
        }
        self.streamsById.set(streamId, record)
      },
      cancel(reason) {
        const record = self.streamsById.get(streamId)
        if (record) {
          if (record.controller) {
            try { record.controller.close() } catch { /* ignore */ }
          }
          self.streamsById.delete(streamId)
        }
        args.rpcReject(reason instanceof Error ? reason : new Error(String(reason)))
        rejectDone(reason instanceof Error ? reason : new Error(String(reason)))
      },
    })
    return { stream, done }
  }

  private openOutboundStream(args: {
    streamId: string
    stream: ReadableStream<Uint8Array>
    rpcResolve: (result: unknown) => void
    rpcReject: (err: Error) => void
  }): { streamId: string; done: Promise<{ bytesWritten: number }> } {
    const streamId = args.streamId
    let resolveDone!: (b: { bytesWritten: number }) => void
    let rejectDone!: (err: Error) => void
    const done = new Promise<{ bytesWritten: number }>((res, rej) => {
      resolveDone = res
      rejectDone = rej
    })
    this.streamsById.set(streamId, {
      streamId,
      resolve(bytes: number) {
        resolveDone({ bytesWritten: bytes })
      },
      reject: rejectDone,
    });
    (async () => {
      const reader = args.stream.getReader()
      try {
        while (true) {
          const { value, done: chunkDone } = await reader.read()
          if (chunkDone) break
          this.ws.send(encodeStreamChunk(hexToBytes(streamId), value))
        }
        this.ws.send(encodeRpc({
          method: 'streamEnd',
          params: { streamId, bytes: 0 },
        }))
        args.rpcResolve(undefined)
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        rejectDone(e)
        args.rpcReject(e)
      }
    })()
    return { streamId, done }
  }

  private writeFileStreamImpl(params: { path: string; stream: ReadableStream<Uint8Array>; size?: number }): Promise<WriteFileStreamResult> {
    return new Promise<WriteFileStreamResult>((resolve, reject) => {
      const id = this.nextId++
      const req: rpc.RpcRequest = {
        id,
        method: 'writeFile',
        params: {
          path: params.path,
          ...(params.size !== undefined ? { size: params.size } : {}),
        } satisfies rpc.WriteFileParams,
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc 'writeFile' timed out`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (r) => {
          const result = r as { streamId?: string }
          if (!result.streamId) {
            reject(new Error('Daemon returned no streamId for streaming writeFile'))
            return
          }
          const { done } = this.openOutboundStream({
            streamId: result.streamId,
            stream: params.stream,
            rpcResolve: () => resolve({ streamId: result.streamId!, done }),
            rpcReject: reject,
          })
        },
        reject,
        timer,
      })
      this.ws.send(encodeRpc(req))
    })
  }

  private async readFileStreamImpl(params: { path: string }): Promise<ReadFileStreamResult> {
    return new Promise<ReadFileStreamResult>((resolve, reject) => {
      const id = this.nextId++
      const req: rpc.RpcRequest = { id, method: 'readFile', params }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc 'readFile' timed out`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (r) => {
          const result = r as rpc.RpcReadFileStream
          if (!result.streamId) {
            reject(new Error('Daemon returned no streamId for streaming readFile'))
            return
          }
          const { stream, done } = this.openInboundStream({
            streamId: result.streamId,
            rpcResolve: () => resolve({ streamId: result.streamId!, stream, totalSize: result.totalSize, done }),
            rpcReject: reject,
          })
        },
        reject,
        timer,
      })
      this.ws.send(encodeRpc(req))
    })
  }

  ping(): Promise<rpc.PingResult> { return this.call<rpc.PingResult>('ping') }
  startServer(): Promise<void> { return this.call<void>('startServer') }
  stopServer(params?: { timeoutSeconds?: number }): Promise<void> { return this.call<void>('stopServer', params) }

  async readFile(params: { path: string }): Promise<Uint8Array>
  async readFile(params: { path: string; encode: 'utf-8' }): Promise<string>
  async readFile(params: { path: string; encode?: 'utf-8' }): Promise<string | Uint8Array> {
    const stream = await this.readFileStreamImpl({ path: params.path })
    const chunks: Uint8Array[] = []
    let bytes = 0
    const doneDrained = stream.done.catch(() => {})
    const reader = stream.stream.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(value)
        bytes += value.byteLength
      }
    } finally {
      await doneDrained
    }
    const merged = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return params.encode === 'utf-8' ? new TextDecoder('utf-8').decode(merged) : merged
  }

  async writeFile(params: { path: string; data: Uint8Array | string }): Promise<{ bytesWritten: number }> {
    const bytes = typeof params.data === 'string'
      ? new TextEncoder().encode(params.data)
      : params.data
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    const result = await this.writeFileStreamImpl({ path: params.path, stream })
    return { bytesWritten: (await result.done).bytesWritten }
  }

  readFileStream(params: { path: string }): Promise<ReadFileStreamResult> { return this.readFileStreamImpl(params) }
  writeFileStream(params: { path: string; stream: ReadableStream<Uint8Array>; size?: number }): Promise<WriteFileStreamResult> { return this.writeFileStreamImpl(params) }

  executeRawCommand(params: { command: string }): Promise<rpc.ExecuteRawCommandResult> { return this.call<rpc.ExecuteRawCommandResult>('executeRawCommand', params) }

  async attachLog(params?: { regex?: string }): Promise<AttachLogSubscription> {
    const res = await this.call<{ subscriptionId: string }>('attachLog', params)
    return this.buildSingle(res.subscriptionId)
  }

  getActiveConfig() { return this.call<rpc.GetActiveConfigResult>('getActiveConfig') }
  getBuildOutputTree(params?: { path?: string; limit?: number }) { return this.call<rpc.GetBuildOutputTreeResult>('getBuildOutputTree', params) }
  readBuildLog(params?: rpc.ReadBuildLogParams) { return this.call<rpc.ReadBuildLogResult>('readBuildLog', params) }
  readTestLog(params?: rpc.ReadBuildLogParams) { return this.call<rpc.ReadTestLogResult>('readTestLog', params) }
  readServerLog(params?: rpc.ReadServerLogParams) { return this.call<rpc.ReadServerLogResult>('readServerLog', params) }
  readClientLog(params?: rpc.ReadClientLogParams) { return this.call<rpc.ReadClientLogResult>('readClientLog', params) }
  getWatchedFiles() { return this.call<rpc.GetWatchedFilesResult>('getWatchedFiles') }
  getRebuildState() { return this.call<rpc.GetRebuildStateResult>('getRebuildState') }
  getWatcherStatus() { return this.call<rpc.GetWatcherStatusResult>('getWatcherStatus') }
  publishConfig(params: rpc.PublishConfigParams) { return this.call<void>('publishConfig', params) }
  publishLog(params: rpc.PublishLogParams) { return this.call<void>('publishLog', params) }
  publishRebuild(params: rpc.PublishRebuildParams) { return this.call<void>('publishRebuild', params) }
  publishWatcherStatus(params: rpc.PublishWatcherStatusParams) { return this.call<void>('publishWatcherStatus', params) }
  publishTriggerBuild() { return this.call<rpc.PublishTriggerBuildResult>('publishTriggerBuild') }
  shutdown() { return this.call<void>('shutdown') }

  onShutdown(handler: (reason: string) => void): () => void {
    this.shutdownHandlers.add(handler)
    return () => {
      this.shutdownHandlers.delete(handler)
    }
  }

  onConfigChanged(handler: (event: ConfigChangedEvent) => void): () => void {
    this.configChangedHandlers.add(handler)
    return () => {
      this.configChangedHandlers.delete(handler)
    }
  }

  onTriggerBuild(handler: (event: { at: string }) => void): () => void {
    this.triggerHandlers.add(handler)
    return () => {
      this.triggerHandlers.delete(handler)
    }
  }

  setFallbackNotificationHandler(handler: FallbackNotificationHandler): void {
    this.fallbackNotificationHandler = handler
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.ws.close()
  }
}

/** Backwards-compatible factory. Prefer `Client.open()`. */
export async function connect(opts: ClientOptions): Promise<Client> {
  return Client.open(opts)
}

/** Assert WS frame data is a Uint8Array (Bun's WS contract). */
function Bytes(data: unknown): Uint8Array {
  if (!(data instanceof Uint8Array)) {
    throw new Error(`expected Uint8Array frame, got ${typeof data}${data instanceof Blob ? ' (Blob)' : ''}`)
  }
  return data
}

function rpcErrorToException(e: rpc.RpcError): Error {
  const msg = `[rpc ${e.code}] ${e.message}`
  const err = new Error(msg)
  ;(err as Error & { code: number }).code = e.code
  return err
}
