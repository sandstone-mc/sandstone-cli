/**
 * Minimal WebSocket client for the `sand connect` daemon.
 *
 * Wire protocol is msgpack-encoded JSON-RPC envelopes + binary
 * stream-chunk frames (16-byte streamId + payload). Every RPC and
 * event rides on the same single WS; only the chunk frames use a
 * separate encoding.
 *
 * Used by `sand connect --shutdown` and by the MCP server when
 * bridging daemon pushes to the MCP stdio transport.
 *
 * Bun's global `WebSocket` is the transport — no extra dep.
 */

import {
  SUBPROTOCOL_PREFIX,
  type ExecuteRawCommandResult,
  type GetActiveConfigResult,
  type GetBuildOutputTreeResult,
  type GetRebuildStateResult,
  type GetWatchedFilesResult,
  type LogLineEntry,
  type PublishConfigParams,
  type PublishLogParams,
  type PublishRebuildParams,
  type PublishTriggerBuildResult,
  type PublishWatcherStatusParams,
  type PingResult,
  type ReadBuildLogParams,
  type ReadBuildLogResult,
  type ReadServerLogParams,
  type ReadServerLogResult,
  type ReadClientLogParams,
  type ReadClientLogResult,
  type GetWatcherStatusResult,
  type ReadTestLogResult,
  type ReadFileParams,
  type ReadFileResult as RpcReadFileResult,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
  type TriggerBuildEvent,
  type WelcomeEvent,
  type WriteFileParams,
} from './rpc.js'
import type { ActiveSaveConfig } from '../../utils/activeSaveConfig.js'
import type { EndpointFile } from './endpoint-file.js'
import {
  decodeRpc,
  decodeStreamChunk,
  encodeRpc,
  encodeStreamChunk,
  hexFromBytes as streamIdToHex,
  newStreamId,
} from './codec.js'

/**
 * Handle returned by `attachLog`. Each call to `onLines` registers a
 * listener for lines from this subscription only.
 */
export interface AttachLogSubscription {
  readonly subscriptionId: string
  /** Register a listener for line batches from this subscription. */
  onLines(fn: (lines: string[]) => void): void
  /** Release the server-side subscription. Safe to call multiple times. */
  unattach(): Promise<void>
}

export interface ClientOptions {
  /** The endpoint file payload (URL + secret) — read by `--shutdown`. */
  endpoint: EndpointFile
  /** Per-request timeout in ms. Default 30s. */
  requestTimeoutMs?: number
}

/** What the streaming `readFile` resolves with. */
export interface ReadFileStreamResult {
  streamId: string
  stream: ReadableStream<Uint8Array>
  /** Best-effort size from the host (may be `undefined`). */
  totalSize?: number
  /** Resolves when the server closes the stream with the final byte count. */
  done: Promise<{ bytesRead: number }>
}

/** What `readFile` returns. */
export interface ReadFileResult {
  /** The full file contents — raw `Uint8Array`, or a UTF-8 string
   *  if `encode: 'utf-8'` was passed. */
  data: Uint8Array | string
  /** Final byte count (raw, before any encoding). */
  bytesRead: number
}

/** What `writeFile` with a stream resolves with. */
export interface WriteFileStreamResult {
  streamId: string
  /** Resolves when the server has flushed the host's WritableStream. */
  done: Promise<{ bytesWritten: number }>
}

/**
 * Open a WebSocket to the daemon and resolve once the `welcome` event
 * arrives. The returned client exposes typed RPC helpers + an
 * `onLog` subscription callback.
 */
export async function connect(opts: ClientOptions): Promise<Client> {
  console.error(`[client-trace] connect() called url=${opts.endpoint.url}`)
  // Bun's global WebSocket sends binary frames via `ws.send(uint8)`
  // (auto-detected from the argument type). The browser DOM type
  // signature is identical.
  const ws = new WebSocket(opts.endpoint.url, [SUBPROTOCOL_PREFIX + opts.endpoint.secret])
  const timeoutMs = opts.requestTimeoutMs ?? 30_000

  const welcome = await new Promise<WelcomeEvent>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('welcome timed out')), timeoutMs)
    ws.addEventListener('open', () => {
      console.error(`[client-trace] ws open`)
      // wait for first message
    })
    ws.addEventListener('error', (e) => {
      console.error(`[client-trace] ws error: ${e}`)
      clearTimeout(t)
      reject(new Error(`ws error: ${e}`))
    })
    ws.addEventListener('close', (e) => {
      console.error(`[client-trace] ws close code=${e?.code} reason=${e?.reason}`)
    })
    // Welcome-await listener. Stored so we can detach it after the
    // welcome resolves — otherwise it runs for every subsequent
    // message, doing a wasted msgpack decode + JSON.stringify + no-op
    // welcome check on every frame (including stream chunks, which
    // fail to decode and log spurious errors).
    const onWelcomeMessage = (ev: MessageEvent) => {
      const buf = toBytes(ev.data)
      console.error(`[client-trace] welcome raw type=${typeof ev.data} ctor=${ev.data?.constructor?.name} bytes=${buf.byteLength}`)
      let parsed: unknown
      try { parsed = decodeRpc(buf).value } catch (e) {
        console.error(`[client-trace] decodeRpc threw: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      console.error(`[client-trace] parsed=${JSON.stringify(parsed)?.slice(0, 200)}`)
      if (parsed && typeof parsed === 'object' && 'event' in parsed && (parsed as { event: unknown }).event === 'welcome') {
        clearTimeout(t)
        ws.removeEventListener('message', onWelcomeMessage)
        resolve((parsed as unknown as { data: WelcomeEvent }).data)
      }
    }
    ws.addEventListener('message', onWelcomeMessage)
  })

  const pending = new Map<string | number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  // Per-subscriptionId listener set. Each `attachLog` call produces a
  // LogSubscription whose `onLines` registers here; the websocket log
  // event dispatches by subscriptionId.
  type InternalListener = (lines: string[]) => void
  const listenersBySub = new Map<string, Set<InternalListener>>()
  // Open streams. Inbound (readFile) records carry a controller for
  // the consumer's ReadableStream + a resolver that fulfills `done`
  // when the matching `streamEnd` envelope arrives. Outbound
  // (writeFile) records have no controller — the caller's source
  // ReadableStream drives the chunks; we only need the resolver so
  // `done` settles when the server signals end. The unified map
  // lets the message dispatcher route the streamEnd envelope for
  // either direction through the same lookup.
  type StreamRecord = {
    streamId: string
    /** Inbound only — undefined for outbound (writeFile) streams. */
    controller?: ReadableStreamDefaultController<Uint8Array>
    resolve: (bytes: number) => void
    reject: (err: Error) => void
  }
  const streamsById = new Map<string, StreamRecord>()
  // Shutdown listeners registered via `Client.onShutdown`. Fired once
  // when the daemon broadcasts `daemonShutdown`, then cleared. Each
  // call returns an unsubscribe closure so callers can detach.
  const shutdownHandlers = new Set<(reason: string) => void>()
  // Config-change listeners registered via `Client.onConfigChanged`. Fired
  // every time the daemon pushes a `configChanged` event (i.e. whenever
  // the watcher publishes a new snapshot). Each call returns an
  // unsubscribe closure so callers can detach.
  const configChangedHandlers = new Set<(event: { saveConfig: ActiveSaveConfig | undefined; mode: 'pack' | 'library'; configPath: string; detectedAt: string }) => void>()
  // Trigger-build listeners registered via `Client.onTriggerBuild`.
  // Fired when the daemon broadcasts a `triggerBuild` event (after
  // MCP `runWorkspaceBuild` calls `publishTriggerBuild`).
  const triggerHandlers = new Set<(event: TriggerBuildEvent) => void>()
  // Catch-all fallback for WS-received notifications that don't match
  // any typed handler. Used by MCP to bridge daemon pushes
  // (e.g. `notifications/resources/updated`) to the stdio transport.
  let fallbackNotificationHandler: ((notif: { method: string; params?: unknown }) => Promise<void> | void) | undefined
  let nextId = 1
  let closed = false

  ws.addEventListener('message', (ev) => {
    // Normalize first — Bun delivers binary frames as `Buffer`
    // (Uint8Array subclass), not always as `ArrayBuffer`. An
    // instanceof ArrayBuffer check alone would drop every chunk
    // from the server.
    const buf = toBytes(ev.data)
    // Binary frame: treat as a stream chunk ONLY when the first 16
    // bytes match a registered stream. Envelopes (request /
    // response / event / notification) also ride on msgpack-
    // encoded binary frames — they're often ≥17 bytes (welcome is
    // ~222 bytes) so a length check alone can't disambiguate. Peek
    // the registry: an unknown streamId means this isn't a stream
    // frame, fall through to envelope decoding.
    if (typeof ev.data !== 'string' && buf.byteLength >= 17) {
      const candidateStreamId = buf.slice(0, 16)
      const candidateKey = hexFromBytes(candidateStreamId)
      const record = streamsById.get(candidateKey)
      if (record) {
        // Chunks only arrive for inbound (readFile) streams, which
        // always carry a controller. Outbound streams flow the
        // other direction and don't receive chunks.
        if (record.controller) {
          const { chunk } = decodeStreamChunk(buf)
          try {
            record.controller.enqueue(chunk)
          } catch {
            // controller already closed
          }
        }
        return
      }
    }
    const parsed = decodeRpc(buf).value as RpcResponse | { event?: string; data?: unknown; method?: string; params?: unknown }
    if ('event' in parsed && parsed.event === 'log') {
      const logData = parsed.data as { subscriptionId: string; lines: string[]; hostType?: string }
      const subs = listenersBySub.get(logData.subscriptionId)
      if (!subs) return
      for (const fn of subs) fn(logData.lines)
      return
    }
    if ('event' in parsed && parsed.event === 'daemonShutdown') {
      const reason = (parsed.data as { reason?: string } | undefined)?.reason ?? 'unknown'
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer)
        reject(new Error('daemon shutting down'))
      }
      pending.clear()
      // Fire-and-forget — handler errors shouldn't block the close path.
      for (const h of shutdownHandlers) {
        try { h(reason) } catch { /* swallow */ }
      }
      shutdownHandlers.clear()
      // Close the WS from our side so the daemon's `server.stop()`
      // doesn't hang waiting for our close frame. Setting `closed` here
      // makes the later `close` WS-event handler a no-op and keeps
      // explicit `client.close()` calls idempotent.
      closed = true
      try {
        ws.close(1001, 'daemon shutting down')
      } catch {
        // already closed / never opened
      }
      return
    }
    if ('event' in parsed && parsed.event === 'configChanged') {
      for (const h of configChangedHandlers) {
        try { h(parsed.data as { saveConfig: ActiveSaveConfig | undefined; mode: 'pack' | 'library'; configPath: string; detectedAt: string }) } catch { /* swallow */ }
      }
      return
    }
    if ('event' in parsed && parsed.event === 'triggerBuild') {
      for (const h of triggerHandlers) {
        try { h(parsed.data as TriggerBuildEvent) } catch { /* swallow */ }
      }
      return
    }
    if ('event' in parsed && parsed.event === 'streamEnd') {
      const data = parsed.data as { streamId: string; bytes: number }
      const record = streamsById.get(data.streamId)
      if (record) {
        // Inbound streams carry a controller we close to signal the
        // consumer's ReadableStream end-of-stream. Outbound (write)
        // streams have no controller — `resolve` alone settles `done`.
        if (record.controller) {
          try { record.controller.close() } catch { /* already closed */ }
        }
        record.resolve(data.bytes)
        streamsById.delete(data.streamId)
      }
      return
    }
    if ('event' in parsed && parsed.event === 'streamError') {
      // Server-side host failure (SFTP drop, file deleted mid-read,
      // disk full mid-write, etc.). Two paths:
      //
      //  - **Inbound** (readFile/readFileStream): error the
      //    controller so the consumer's reader loop rejects. That's
      //    the canonical failure signal.
      //
      //  - **Outbound** (writeFile/writeFileStream): there's no
      //    consumer-side reader — reject the `done` promise so the
      //    caller's `await result.done` settles with the host error.
      //
      // Both are deferred via `queueMicrotask` so the rejection /
      // controller-error fires in a fresh microtask — after the
      // consumer's catch handler is in place. Without the defer,
      // bun:test's stricter unhandled-rejection check can fire
      // before the consumer catches, miscounting an expected
      // failure as a test-level unhandled error.
      const data = parsed.data as { streamId: string; code: number; message: string }
      const record = streamsById.get(data.streamId)
      if (record) {
        const err = new Error(data.message)
        streamsById.delete(data.streamId)
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
    // Any other server-pushed event. Two shapes:
    //   - Legacy `{event, data}` envelope (configChanged, triggerBuild, log, ...)
    //   - Standard JSON-RPC `{method, params}` notification (resources/updated, ...)
    // Catch-all fallback fires for either shape, re-emitting to the
    // MCP client's stdio transport.
    if (fallbackNotificationHandler) {
      const evt = 'event' in parsed && parsed.event !== undefined
        ? { method: parsed.event, params: parsed.data }
        : 'method' in parsed && parsed.method !== undefined
          ? { method: parsed.method, params: parsed.params }
          : null
      if (evt) {
        Promise.resolve(fallbackNotificationHandler(evt))
          .catch(() => { /* swallow */ })
        return
      }
    }
    if ('id' in parsed && (parsed as RpcResponse).id !== undefined) {
      const resp = parsed as RpcResponse
      const handler = pending.get(resp.id)
      if (!handler) return
      pending.delete(resp.id)
      clearTimeout(handler.timer)
      if (resp.error) handler.reject(rpcErrorToException(resp.error))
      else handler.resolve(resp.result)
    }
  })

  ws.addEventListener('close', () => {
    if (closed) return
    closed = true
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(new Error('connection closed'))
    }
    pending.clear()
    // Tear down any in-flight streams — consumers will see their
    // ReadableStream reject on next read; outbound streams just
    // settle `done` with an error (no consumer-side stream).
    for (const [id, record] of streamsById) {
      if (record.controller) {
        try { record.controller.error(new Error('connection closed')) } catch { /* ignore */ }
      }
      record.reject(new Error('connection closed'))
      streamsById.delete(id)
    }
  })

  function call<T>(method: string, params?: unknown): Promise<T> {
    if (closed) return Promise.reject(new Error('connection closed'))
    const id = nextId++
    const req: RpcRequest = { id, method: method as RpcMethod, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`rpc '${method}' timed out`))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer })
      ws.send(encodeRpc(req))
    })
  }

  function buildSingle(subscriptionId: string): AttachLogSubscription {
    let detached = false
    const set = new Set<InternalListener>()
    listenersBySub.set(subscriptionId, set)
    return {
      subscriptionId,
      onLines(fn: (lines: string[]) => void) {
        set.add((lines) => fn(lines))
      },
      async unattach() {
        if (detached) return
        detached = true
        listenersBySub.delete(subscriptionId)
        try {
          await call<void>('unattach', { subscriptionId })
        } catch {
          // Daemon may already be gone; the server-side subscription
          // will cascade-clean via ws close. Swallow.
        }
      },
    }
  }

  /**
   * Open an inbound stream: the server pushes binary chunks via
   * `streamId`-tagged frames, then closes with a `streamEnd`
   * envelope. We expose the chunks as a `ReadableStream` for the
   * caller and resolve `done` with the final byte count.
   *
   * `streamId` is the SERVER's streamId (returned by the readFile
   * RPC). Both sides must agree on this id — server tags each
   * outgoing chunk with it in the binary header, and we look up the
   * matching `StreamRecord` by the same id. Generating a local id
   * here would silently drop every chunk.
   */
  function openInboundStream(args: {
    streamId: string
    rpcResolve: (result: unknown) => void
    rpcReject: (err: Error) => void
  }): { stream: ReadableStream<Uint8Array>; done: Promise<{ bytesRead: number }> } {
    const streamId = args.streamId
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
            // The outer RPC was already resolved with `{streamId,
            // stream, totalSize, done}` from the caller side —
            // `rpcResolve` doesn't need any payload here. Pass
            // `undefined` explicitly to keep the type signature
            // (`(result: unknown) => void`) honest without trying to
            // spread undefined (which throws).
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
        streamsById.set(streamId, record)
      },
      cancel(reason) {
        const record = streamsById.get(streamId)
        if (record) {
          if (record.controller) {
            try { record.controller.close() } catch { /* ignore */ }
          }
          streamsById.delete(streamId)
        }
        args.rpcReject(reason instanceof Error ? reason : new Error(String(reason)))
        rejectDone(reason instanceof Error ? reason : new Error(String(reason)))
      },
    })
    return { stream, done }
  }

  /**
   * Open an outbound stream: the caller pumps a `ReadableStream`
   * into the daemon's WritableStream via binary chunk frames, then
   * the daemon signals end via `streamEnd`. Resolves when the host
   * has fully written the bytes.
   *
   * `streamId` is the SERVER's streamId (returned by the writeFile
   * RPC) — both sides must tag every frame + the `streamEnd`
   * notification with the same id or the server silently drops
   * every chunk.
   */
  function openOutboundStream(args: {
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
    // Register in `streamsById` so the message dispatcher can find
    // us when the server's matching `streamEnd` envelope arrives.
    // No controller — the source ReadableStream drives the chunks;
    // we only need the resolver so `done` settles correctly.
    streamsById.set(streamId, {
      streamId,
      // `resolveDone` takes `{bytesWritten: number}` but the unified
      // `StreamRecord` resolver signature is `(bytes: number) => void`
      // — wrap so the byte count lands in the right field.
      resolve(bytes: number) {
        resolveDone({ bytesWritten: bytes })
      },
      reject: rejectDone,
    })
    void (async () => {
      const reader = args.stream.getReader()
      try {
        while (true) {
          const { value, done: chunkDone } = await reader.read()
          if (chunkDone) break
          ws.send(encodeStreamChunk(hexToBytesForWrite(streamId), value))
        }
        // Tell the server to finalise the host stream. The
        // server's `tryParseMethodNotification` branch routes this
        // through `handleStreamEnd` → `streams.close(streamId,
        // bytes)` → host writer gets `.close()`'d → server sends a
        // matching `streamEnd` envelope back, which resolves `done`
        // via the message dispatcher.
        ws.send(encodeRpc({
          method: 'streamEnd',
          params: { streamId, bytes: 0 },
        }))
        // The matching `streamEnd` envelope from the daemon will
        // resolve `done` (handled in the message dispatcher).
        args.rpcResolve(undefined)
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        rejectDone(e)
        args.rpcReject(e)
      }
    })()
    return { streamId, done }
  }

  /**
   * Local helper: issue the streaming `writeFile` RPC, pump the
   * caller's `stream` chunks as binary frames, and resolve when
   * the server signals `streamEnd`. Used by both the public
   * `writeFileStream` and the buffering `writeFile` below.
   */
  function writeFileStreamImpl(params: { path: string; stream: ReadableStream<Uint8Array>; size?: number }): Promise<WriteFileStreamResult> {
    return new Promise<WriteFileStreamResult>((resolve, reject) => {
      const id = nextId++
      // `size` is forwarded when the caller knows the final byte
      // count (e.g. uploading an existing file of known length).
      // Hosts whose upload protocol needs the size up front can
      // avoid buffering the whole file. Hosts with native streaming
      // backends ignore it.
      const req: RpcRequest = {
        id,
        method: 'writeFile',
        params: {
          path: params.path,
          ...(params.size !== undefined ? { size: params.size } : {}),
        } satisfies WriteFileParams,
      }
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`rpc 'writeFile' timed out`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (r) => {
          const result = r as { streamId?: string }
          if (!result.streamId) {
            reject(new Error('Daemon returned no streamId for streaming writeFile'))
            return
          }
          const { streamId, done } = openOutboundStream({
            streamId: result.streamId,
            stream: params.stream,
            rpcResolve: () => resolve({ streamId: result.streamId!, done }),
            rpcReject: reject,
          })
          void streamId
        },
        reject,
        timer,
      })
      ws.send(encodeRpc(req))
    })
  }

  /**
   * Local helper: issue the streaming `readFile` RPC and return the
   * inbound `ReadableStream` plus a `done` promise. Used by both
   * the public `readFileStream` method and the buffering `readFile`
   * method below.
   */
  async function readFileStreamImpl(params: { path: string }): Promise<ReadFileStreamResult> {
    return new Promise<ReadFileStreamResult>((resolve, reject) => {
      const id = nextId++
      const req: RpcRequest = { id, method: 'readFile', params }
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`rpc 'readFile' timed out`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (r) => {
          const result = r as RpcReadFileResult
          if (!result.streamId) {
            reject(new Error('Daemon returned no streamId for streaming readFile'))
            return
          }
          const { stream, done } = openInboundStream({
            streamId: result.streamId,
            rpcResolve: () => resolve({ streamId: result.streamId!, stream, totalSize: result.totalSize, done }),
            rpcReject: reject,
          })
          void stream
        },
        reject,
        timer,
      })
      ws.send(encodeRpc(req))
    })
  }

  return {
    welcome,
    ping: () => call<PingResult>('ping'),
    startServer: () => call<void>('startServer'),
    stopServer: (params) => call<void>('stopServer', params),
    readFile: async (params: { path: string; encode?: 'utf-8' }): Promise<ReadFileResult> => {
      // Wire path: always streaming. Internally: consume the stream
      // into a single buffer (TextDecoder handles UTF-8 if requested).
      const stream = await readFileStreamImpl({ path: params.path })
      const chunks: Uint8Array[] = []
      let bytes = 0
      // Attach the done-drain BEFORE the reader loop so `done`
      // always has an awaiter. Without this, the server's
      // `streamError` envelope handler can fire `done.reject(err)`
      // before this function reaches its own drain — leaving a
      // brief window where the rejection is unhandled and bun:test
      // reports the expected failure as an unhandled-promise error.
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
        // Always settle the drain — even on the error path, where
        // the reader loop's rejection is the canonical failure
        // signal that propagates out of this function.
        await doneDrained
      }
      const merged = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      const data = params.encode === 'utf-8' ? new TextDecoder('utf-8').decode(merged) : merged
      return { data, bytesRead: bytes }
    },
    writeFile: async (params: { path: string; data: Uint8Array | string }): Promise<{ bytesWritten: number }> => {
      // Convert string → UTF-8 bytes, then stream-write. Internally
      // uses the streaming `writeFile` RPC — wire format is always
      // raw `Uint8Array` chunks.
      const bytes = typeof params.data === 'string'
        ? new TextEncoder().encode(params.data)
        : params.data
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
      const result = await writeFileStreamImpl({ path: params.path, stream })
      return { bytesWritten: (await result.done).bytesWritten }
    },
    readFileStream: (params) => readFileStreamImpl(params),
    writeFileStream: (params: { path: string; stream: ReadableStream<Uint8Array>; size?: number }) => writeFileStreamImpl(params),
    executeRawCommand: (params) => call<ExecuteRawCommandResult>('executeRawCommand', params),
    async attachLog(params) {
      const res = await call<{ subscriptionId: string }>('attachLog', params)
      return buildSingle(res.subscriptionId)
    },
    getActiveConfig: () => call<GetActiveConfigResult>('getActiveConfig'),
    getBuildOutputTree: (params) => call<GetBuildOutputTreeResult>('getBuildOutputTree', params),
    readBuildLog: (params: ReadBuildLogParams) => call<ReadBuildLogResult>('readBuildLog', params),
    readTestLog: (params: ReadBuildLogParams) => call<ReadTestLogResult>('readTestLog', params),
    readServerLog: (params: ReadServerLogParams) => call<ReadServerLogResult>('readServerLog', params),
    readClientLog: (params: ReadClientLogParams) => call<ReadClientLogResult>('readClientLog', params),
    getWatchedFiles: () => call<GetWatchedFilesResult>('getWatchedFiles'),
    getRebuildState: () => call<GetRebuildStateResult>('getRebuildState'),
    getWatcherStatus: () => call<GetWatcherStatusResult>('getWatcherStatus'),
    publishConfig: (params: PublishConfigParams) => call<void>('publishConfig', params),
    publishLog: (params: PublishLogParams) => call<void>('publishLog', params),
    publishRebuild: (params: PublishRebuildParams) => call<void>('publishRebuild', params),
    publishWatcherStatus: (params: PublishWatcherStatusParams) => call<void>('publishWatcherStatus', params),
    publishTriggerBuild: () => call<PublishTriggerBuildResult>('publishTriggerBuild'),
    shutdown: () => call<void>('shutdown'),
    onShutdown(handler: (reason: string) => void): () => void {
      shutdownHandlers.add(handler)
      return () => {
        shutdownHandlers.delete(handler)
      }
    },
    onConfigChanged(handler: (event: { saveConfig: ActiveSaveConfig | undefined; mode: 'pack' | 'library'; configPath: string; detectedAt: string }) => void): () => void {
      configChangedHandlers.add(handler)
      return () => {
        configChangedHandlers.delete(handler)
      }
    },
    setFallbackNotificationHandler(handler) {
      fallbackNotificationHandler = async (n) => {
        await handler(n)
      }
    },
    onTriggerBuild(handler: (event: { at: string }) => void): () => void {
      triggerHandlers.add(handler)
      return () => {
        triggerHandlers.delete(handler)
      }
    },
    close() {
      if (closed) return
      closed = true
      ws.close()
    },
  }
}

export interface Client {
  readonly welcome: WelcomeEvent
  ping(): Promise<PingResult>
  startServer(): Promise<void>
  stopServer(params?: { timeoutSeconds?: number }): Promise<void>
  /**
   * Read a file. Internally uses the streaming RPC. With
   * `encode: 'utf-8'`, returns the file as a decoded string in
   * `data`; otherwise returns raw `Uint8Array` bytes.
   */
  readFile(params: { path: string; encode?: 'utf-8' }): Promise<ReadFileResult>
  /**
   * Streaming readFile: opens a `ReadableStream` over the WS and
   * resolves `done` with the final byte count when the server
   * closes the stream. Caller iterates the stream to receive
   * chunks as they arrive.
   */
  readFileStream(params: { path: string }): Promise<ReadFileStreamResult>
  /**
   * Write a file. `data` may be a raw `Uint8Array` (binary) or a
   * string (encoded as UTF-8 before streaming). Internally uses the
   * streaming `writeFile` RPC — wire format is always raw bytes.
   */
  writeFile(params: { path: string; data: Uint8Array | string }): Promise<{ bytesWritten: number }>
  /**
   * Streaming writeFile: pipes `stream` into the daemon's
   * WritableStream over the WS. Resolves with a `done` promise
   * once the host has fully written the bytes.
   */
  writeFileStream(params: { path: string; stream: ReadableStream<Uint8Array>; size?: number }): Promise<WriteFileStreamResult>
  executeRawCommand(params: { command: string }): Promise<ExecuteRawCommandResult>
  /** Subscribe to the host's log stream. */
  attachLog(params?: { regex?: string }): Promise<AttachLogSubscription>
  /**
   * Return the daemon's current `sandstone.config.ts` snapshot. The
   * daemon seeds this from disk at boot and refreshes it whenever the
   * `sand watch` process publishes a new one via `publishConfig`.
   */
  getActiveConfig(): Promise<GetActiveConfigResult>
  /** List one level of the build output directory. */
  getBuildOutputTree(params?: { path?: string; limit?: number }): Promise<GetBuildOutputTreeResult>
  /** Tail the watcher's log buffer with optional line/range/time filtering. */
  readBuildLog(params?: ReadBuildLogParams): Promise<ReadBuildLogResult>
  /**
   * Tail the test-runner's log buffer. Returns empty lines today — the
   * test runner backend hasn't been wired yet. Same filtering shape as
   * `readBuildLog` so the MCP resource can offer identical query
   * semantics once data starts flowing.
   */
  readTestLog(params?: ReadBuildLogParams): Promise<ReadTestLogResult>
  /**
   * Tail the host's stdout buffer (populated by the daemon's own
   * `attachLog` subscription at boot). In-memory only — never reads
   * `logs/latest.log` from disk. Same filtering shape as `readBuildLog`.
   */
  readServerLog(params?: ReadServerLogParams): Promise<ReadServerLogResult>
  /**
   * Read the Minecraft client launcher log. Intrinsic daemon
   * capability — the daemon streams the file directly from
   * `saveConfig.clientPath/logs/latest.log`. Same tail / maxLines /
   * range semantics as `readBuildLog`.
   */
  readClientLog(params?: ReadClientLogParams): Promise<ReadClientLogResult>
  /**
   * List files the watcher is tracking. Currently a stub — returns
   * `{files: []}` because the daemon doesn't track per-file state.
   * Clients that want fine-grained events should listen for
   * `configChanged` and `rebuildComplete` (the latter when the watcher
   * starts pushing it).
   */
  getWatchedFiles(): Promise<GetWatchedFilesResult>
  /**
   * Watcher → daemon push of the current config snapshot. Called by
   * `sand watch` on boot and after every hot-reload of
   * `sandstone.config.ts`. Other connected clients (notably `sand mcp`)
   * receive a `configChanged` event in response.
   */
  publishConfig(params: PublishConfigParams): Promise<void>
  /**
   * Read the latest build state the watcher pushed via
   * `publishRebuild`. Returns `null` if no watcher has pushed one
   * yet. MCP server reads this when serving
   * `resources/read sandstone://rebuild-state`.
   */
  getRebuildState(): Promise<GetRebuildStateResult>
  /**
   * Push log lines to the daemon's bounded buffer. The watcher calls
   * this for every line it would have written to its `watch.log` file;
   * MCP reads the buffer via {@link readBuildLog}. Each entry
   * includes the timestamp the watcher stamped when the line was
   * emitted — daemon stores verbatim, no re-stamping on receipt.
   */
  publishLog(params: PublishLogParams): Promise<void>
  /**
   * Push the current build's lifecycle state to the daemon. Watcher
   * calls this at build start (`state: 'started'`) and at completion
   * (`'complete'` or `'failed'`). Daemon caches the latest snapshot
   * and fires `notifications/resources/updated` for
   * `sandstone://rebuild-state` so subscribed MCP clients see live
   * start/finish events.
   */
  publishRebuild(params: PublishRebuildParams): Promise<void>
  /**
   * Push the watcher's runtime status. Called by `sand watch` on
   * connect (after attaching the log subscription). The daemon caches
   * the snapshot, flips `connected: false` when this WS session ends,
   * and exposes it via `getWatcherStatus` to MCP's
   * `sandstone://watcher-status` resource.
   */
  publishWatcherStatus(params: PublishWatcherStatusParams): Promise<void>
  /**
   * Tell the daemon to fan out a `triggerBuild` event to the
   * connected watcher. Returns `{triggered: true}` if accepted.
   */
  publishTriggerBuild(): Promise<PublishTriggerBuildResult>
  /**
   * Read the current watcher status. Returns `null` if no watcher has
   * connected since the daemon started.
   */
  getWatcherStatus(): Promise<GetWatcherStatusResult>
  shutdown(): Promise<void>
  /**
   * Register a one-shot listener for the daemon's `daemonShutdown`
   * event. The handler fires once when the daemon begins teardown
   * (any reason — signal, EOF, `--shutdown` RPC, host member
   * disconnected). Returns an unsubscribe function. Listeners are
   * auto-cleared after firing.
   */
  onShutdown(handler: (reason: string) => void): () => void
  /**
   * Register a listener for the daemon's `configChanged` events. The
   * handler fires every time the watcher publishes a new snapshot.
   * Returns an unsubscribe function.
   */
  onConfigChanged(handler: (event: { saveConfig: ActiveSaveConfig | undefined; mode: 'pack' | 'library'; configPath: string; detectedAt: string }) => void): () => void
  /**
   * Register a listener for the daemon's `triggerBuild` events. Watcher
   * subscribes to react to MCP `runWorkspaceBuild` calls; the daemon
   * fans the event out after a `publishTriggerBuild` RPC.
   */
  onTriggerBuild(handler: (event: { at: string }) => void): () => void
  /**
   * Set a catch-all handler for WS-received notifications that don't
   * match a typed `onXxx` method. Used by the MCP server to bridge
   * every daemon-pushed notification (e.g. `resources/updated`) to its
   * own MCP client over stdio.
   */
  setFallbackNotificationHandler(handler: (notification: { method: string; params?: unknown }) => Promise<void> | void): void
  close(): void
}

/** Normalise WS frame data to a single Uint8Array. */
function toBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data instanceof Uint8Array) return data
  // Bun delivers binary WS frames as `Uint8Array` directly; this
  // path is only hit if some other transport hands us a Blob/ArrayBufferView
  // variant. Return empty so the decoder can surface a clear error
  // rather than silently dropping bytes.
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    // Web Blobs are async; in practice the daemon side sends
    // ArrayBuffer. If we ever hit this path, we silently return
    // empty and the caller's decodeRpc will throw a parse error
    // — that's the same surface as if no data arrived.
    return new Uint8Array(0)
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return new Uint8Array(0)
}

/** Hex-encode a 16-byte streamId. Local helper for the client. */
function hexFromBytes(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

/** Inverse: 32-char hex to 16 raw bytes. */
function hexToBytesForWrite(hex: string): Uint8Array {
  if (hex.length !== 32) throw new Error(`streamId must be 32 hex chars, got ${hex.length}`)
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function rpcErrorToException(e: RpcError): Error {
  const msg = `[rpc ${e.code}] ${e.message}`
  const err = new Error(msg)
  ;(err as Error & { code: number }).code = e.code
  return err
}