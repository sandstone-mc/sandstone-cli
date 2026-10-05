import type * as rpc from './rpc.js'
import { classifyWsMessage } from './rpc.js'
import type { HostLogLine } from '../../hosts/types.js'
import { TimeoutError, InterruptedError } from './wait-log.js'
import { SUBPROTOCOL_PREFIX } from './rpc.js'
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
import type { SandstoneConfig } from 'sandstone'

export interface AttachLogSubscription {
  readonly subscriptionId: string
  onLines(fn: (lines: HostLogLine[]) => void): void,
  unattach(): Promise<void>,
}

export interface WaitForLogSubscription {
  readonly subscriptionId: string,
  readonly patternUUIDs: string[],
  promises: Promise<string[]>[],
  cancel(): Promise<void>,
}

export interface ClientOptions {
  endpoint: EndpointFile
  /** Defaults to 30s. */
  requestTimeoutMs?: number
}
export interface ReadFileStreamResult {
  streamId: string,
  stream: ReadableStream<Uint8Array>,
  totalSize?: number,
  done: Promise<{ bytesRead: number }>,
}
export interface WriteFileStreamResult {
  streamId: string,
  done: Promise<{ bytesWritten: number }>,
}

type InternalListener = (lines: HostLogLine[]) => void
type StreamRecord = {
  streamId: string,
  /** Inbound only; undefined for outbound (writeFile) streams. */
  controller?: ReadableStreamDefaultController<Uint8Array>,
  resolve: (bytes: number) => void,
  reject: (err: Error) => void,
}
type PendingEntry = { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

type ConfigChangedEvent = {
  saveConfig: SandstoneConfig['saveOptions'] | undefined
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
  private readonly waitForLogBySub = new Map<string, Map<string, {
    resolve: (lines: string[]) => void
    reject: (err: Error) => void
  }>>()
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
      const id = hexFromBytes(streamId)
      const record = this.streamsById.get(id)
      if (!record?.controller) {
        console.error(
          `[ws] orphan stream chunk for id=${id} (known streams: ${this.streamsById.size}) — dropping ${chunk.byteLength} bytes`,
        )
        return
      }
      record.controller.enqueue(chunk)
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
            const logData = msg.data as { subscriptionId: string; lines: HostLogLine[] }
            const subs = this.listenersBySub.get(logData.subscriptionId)
            if (subs) for (const fn of subs) fn(logData.lines)
            return
          }
          case 'waitForLog': {
            const data = msg.data as rpc.WaitForLogEvent
            const entry = this.waitForLogBySub.get(data.subscriptionId)
            const slot = entry?.get(data.patternUUID)
            if (!slot) {
              console.warn(`[ws] unexpected waitForLog event for unknown pattern (subscriptionId=${data.subscriptionId}, patternUUID=${data.patternUUID}, status=${data.status}) — dropping`)
              return
            }
            if (data.status === 'matched') {
              slot.resolve(data.lines)
            } else if (data.status === 'timed_out') {
              slot.reject(new TimeoutError(data.patternIndex, undefined, data.timeoutMs))
            }
            entry!.delete(data.patternUUID)
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

  private call<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'))
    if (signal?.aborted) return Promise.reject(new Error(`rpc '${method}' aborted`))
    const id = this.nextId++
    const req: rpc.RpcRequest = { id, method: method as rpc.RpcMethod, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`rpc '${method}' timed out`))
      }, this.timeoutMs)
      const onAbort = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`rpc '${method}' aborted`))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v as T) },
        reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e) },
        timer,
      })
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
      onLines(fn: (lines: HostLogLine[]) => void) {
        set.add(fn)
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
      let bytesSent = 0
      try {
        while (true) {
          const { value, done: chunkDone } = await reader.read()
          if (chunkDone) break
          this.ws.send(encodeStreamChunk(hexToBytes(streamId), value))
          bytesSent += value.byteLength
        }
        this.ws.send(encodeRpc({
          method: 'streamEnd',
          params: bytesSent > 0
            ? { streamId, bytes: bytesSent }
            : { streamId },
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
  stopServer(): Promise<void> { return this.call<void>('stopServer') }

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
        const CHUNK = 64 * 1024 * 1024
        for (let off = 0; off < bytes.byteLength; off += CHUNK) {
          controller.enqueue(bytes.subarray(off, Math.min(off + CHUNK, bytes.byteLength)))
        }
        controller.close()
      },
    })
    const result = await this.writeFileStreamImpl({ path: params.path, stream, size: bytes.byteLength })
    return { bytesWritten: (await result.done).bytesWritten }
  }

  readFileStream(params: { path: string }): Promise<ReadFileStreamResult> { return this.readFileStreamImpl(params) }
  writeFileStream(params: { path: string; stream: ReadableStream<Uint8Array>; size?: number }): Promise<WriteFileStreamResult> { return this.writeFileStreamImpl(params) }

  executeRawCommand(params: rpc.ExecuteRawCommandParams, signal?: AbortSignal): Promise<rpc.ExecuteRawCommandResult> { return this.call<rpc.ExecuteRawCommandResult>('executeRawCommand', params, signal) }
  reloadResources(signal?: AbortSignal): Promise<void> { return this.call<void>('reloadResources', undefined, signal) }
  waitForLog(params: rpc.WaitForLogParams, signal?: AbortSignal): Promise<WaitForLogSubscription> {
    const client = this
    return this.call<rpc.WaitForLogResult>('waitForLog', params, signal).then((res) => {
      const perUuid = new Map<string, { resolve: (lines: string[]) => void; reject: (err: Error) => void }>()
      client.waitForLogBySub.set(res.subscriptionId, perUuid)
      const promises = res.patternUUIDs.map((uuid) => new Promise<string[]>((resolve, reject) => {
        perUuid.set(uuid, { resolve, reject })
      }))
      const sub: WaitForLogSubscription = {
        subscriptionId: res.subscriptionId,
        patternUUIDs: res.patternUUIDs,
        promises,
        async cancel() {
          // Reject every still-pending promise so callers awaiting see interrupt.
          for (const [uuid, slot] of perUuid) {
            slot.reject(new InterruptedError())
            perUuid.delete(uuid)
          }
          await client.call<void>('unwaitForLog', { subscriptionId: res.subscriptionId })
          client.waitForLogBySub.delete(res.subscriptionId)
        },
      }
      return sub
    })
  }

  async attachLog(params?: { regex?: string }): Promise<AttachLogSubscription> {
    const res = await this.call<{ subscriptionId: string }>('attachLog', params)
    return this.buildSingle(res.subscriptionId)
  }

  getActiveConfig() { return this.call<rpc.GetActiveConfigResult>('getActiveConfig') }
  getBuildOutputTree(params?: { path?: string; limit?: number }) { return this.call<rpc.GetBuildOutputTreeResult>('getBuildOutputTree', params) }
  readBuildLog(params?: rpc.ReadBuildLogParams) { return this.call<rpc.ReadBuildLogResult>('readBuildLog', params) }
  readTestLog(params?: rpc.ReadBuildLogParams) { return this.call<rpc.ReadBuildLogResult>('readTestLog', params) }
  readServerLog(params?: rpc.ReadServerLogParams) { return this.call<rpc.ReadBuildLogResult>('readServerLog', params) }
  readClientLog(params?: rpc.ReadClientLogParams) { return this.call<rpc.ReadClientLogResult>('readClientLog', params) }
  getRebuildState() { return this.call<rpc.GetRebuildStateResult>('getRebuildState') }
  getWatcherStatus() { return this.call<rpc.GetWatcherStatusResult>('getWatcherStatus') }
  publishConfig(params: rpc.PublishConfigParams) { return this.call<void>('publishConfig', params) }
  publishLog(params: rpc.PublishLogParams) { return this.call<void>('publishLog', params) }
  publishRebuild(params: rpc.PublishRebuildParams) { return this.call<void>('publishRebuild', params) }
  publishWatcherStatus(params: rpc.PublishWatcherStatusParams) { return this.call<void>('publishWatcherStatus', params) }
  publishTriggerBuild(signal?: AbortSignal) {
    if (!signal) {
      return this.call<rpc.PublishTriggerBuildResult>('publishTriggerBuild', undefined)
    }
    // When the caller aborts, fire-and-forget a cancel so the watcher
    // can SIGINT the build child the trigger started.
    signal.addEventListener('abort', () => {
      void this.call('cancelTriggerBuild', undefined).catch(() => {})
    }, { once: true })
    return this.call<rpc.PublishTriggerBuildResult>('publishTriggerBuild', undefined, signal)
  }
  cancelTriggerBuild() { return this.call('cancelTriggerBuild', undefined) }
  setBuildMode(params: rpc.SetBuildModeParams) { return this.call<rpc.SetBuildModeResult>('setBuildMode', params) }
  publishTestComplete(params: rpc.TestState) { return this.call<void>('publishTestComplete', params) }
  getTestState() { return this.call<rpc.GetTestStateResult>('getTestState') }
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
