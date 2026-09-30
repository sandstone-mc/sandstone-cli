/**
 * RPC method dispatch.
 *
 * Maps `sand connect` RPC methods onto HostProvider capabilities. Each
 * method is a small `(host, params) => Promise<result>` thunk. Errors
 * are translated to stable RPC codes by {@link errorToRpc}.
 *
 * Pure — does not touch `Bun.serve` or WebSocket state. The server layer
 * wires this in per-connection.
 */

import { resolve as resolvePath } from 'node:path'

import * as fs from '../../utils/fs.js'

import {
  PROTOCOL_VERSION,
  errorToRpc,
  type AttachLogParams,
  type AttachLogResult,
  type BuildOutputEntry,
  type ExecuteRawCommandParams,
  type ExecuteRawCommandResult,
  type GetActiveConfigResult,
  type GetBuildOutputTreeParams,
  type GetBuildOutputTreeResult,
  type GetWatchedFilesResult,
  type PingResult,
  type ReadBuildLogParams,
  type ReadBuildLogResult,
  type ReadTestLogResult,
  type ReadFileResult,
  type ReadFileParams,
  type WriteFileParams,
  type WriteFileResult,
  type ReadServerLogParams,
  type ReadServerLogResult,
  type RebuildState,
  type RpcError,
  type TriggerBuildEvent,
  type WatcherStatus,
  type RpcMethod,
  type RpcRequest,
  type RpcResult,
  type RpcResponse,
  type StopServerParams,
  type UnattachParams,
} from './rpc.js'
import type { SubscriptionRegistry } from './subscriptions.js'
import { StreamRegistry } from './streams.js'
import { encodeStreamChunk, hexToBytes, newStreamId, streamIdHex } from './codec.js'
import { RpcErrorCode, event } from './rpc.js'
import { encodeRpc } from './codec.js'
import { Capability, capabilitiesToRecord } from '../../hosts/types.js'
import type { HostProvider, LogChunkHandler, ServerPath } from '../../hosts/types.js'
import {
  loadActiveConfigFromDisk,
  type ActiveConfig,
} from './active-config.js'
import type { ActiveSaveConfig } from '../../utils/activeSaveConfig.js'
import type { LogStreamTarget } from './rpc.js'
import { setExpectedShutdown } from './daemon.js'

export interface DispatchContext {
  host: HostProvider
  subscriptions: SubscriptionRegistry
  ws: unknown
  /** Coalesce handler pushed by `attachLog`. Created per ws connection.
   *  `subscriptionId` tags the wire batch so the client can route to the
   *  matching subscription's `onLines` callback. */
  pushLog: (lines: string[], subscriptionId: string) => void
  startedAt: number
  /**
   * Live in-memory `sandstone.config.ts` snapshot, seeded at daemon
   * boot from disk and refreshed whenever the watcher pushes a new
   * one via `publishConfig`. `undefined` only when the daemon was
   * started without a project root (unusual; surfaced as
   * `NotConnected` by handlers).
   */
  activeConfig?: ActiveConfig
  /**
   * Push a server-side event to every connected client. Used by
   * `publishConfig` to broadcast `configChanged` after the in-memory
   * state is updated. Optional so dispatch can be invoked without
   * broadcast in tests; in production it's always set by the server
   * layer.
   */
  broadcast?: (eventName: string, data: unknown) => void
  /**
   * Push `notifications/resources/updated` for a specific resource URI
   * to every connected client. Used by `publishRebuild` to fan out
   * start/finish events on `sandstone://rebuild-state`. Optional for
   * the same reason as `broadcast`.
   */
  notifyResourceUpdated?: (uri: string) => void
  /**
   * Called by the server when ANY WS session closes. Used by the
   * daemon to detect watcher disconnects — if the closing ws is the
   * one that published `WatcherStatus`, flip `connected: false` and
   * fire a resource notification.
   */
  onSessionClose?: (ws: unknown) => void
  /**
   * Mutator for the live snapshot. Called by `publishConfig` to atomically
   * swap in the new state; subsequent reads (via the same `dispatchCtx`
   * or any future one) see the new value. Holds a single closure-side
   * ref so the daemon's state is the single source of truth for all
   * connections.
   */
  setActiveConfig?: (cfg: ActiveConfig) => void
  /**
   * Snapshot read of the latest build state the watcher pushed.
   * `undefined` until the first build completes. MCP server reads this
   * when serving `resources/read sandstone://rebuild-state`.
   */
  getRebuildState?: () => RebuildState | undefined
  /**
   * Mutator for the latest build state. Set by `publishRebuild` after
   * parsing the params; subsequent reads via `getRebuildState` see the
   * new value.
   */
  setRebuildState?: (state: RebuildState) => void
  /**
   * Snapshot read of the current watcher status. `null` until the
   * first `publishWatcherStatus` lands; flipped back to `null` when
   * the watcher's WS session closes.
   */
  getWatcherStatus?: () => WatcherStatus | null
  /** Mutator for the current watcher status. */
  setWatcherStatus?: (status: WatcherStatus, ws: unknown) => void
  /**
   * Append log entries to one of the daemon's bounded circular
   * buffers. The watcher/test-runner calls this every time it emits
   * a log line; MCP reads the buffer via `readBuildLog`/`readTestLog`.
   * The buffer is the canonical source — the on-disk log file (e.g.
   * `watch.log`) is only kept for humans tailing it directly.
   */
  appendLogLines?: (entries: { line: string; ts: number }[], target: LogStreamTarget) => void
  /**
   * Read of the daemon-level "expected shutdown in progress" flag.
   * Consumed by `server.ts`'s RPC handler-error path: while set, RPC
   * errors during a graceful stop (e.g. `rcon.executeRawCommand('stop')`
   * raising `NotConnectedError` because rcon was already disconnected)
   * are reported to the client but don't tear the daemon down.
   */
  getExpectedShutdown?: () => boolean
  /**
   * Snapshot read of a named log buffer with filtering. Returns the
   * filtered lines, the buffer's total length (pre-filter), the number
   * of matching entries (post-filter, pre-truncation), and the oldest
   * and newest timestamps in the returned slice.
   */
  readLogBuffer?: (target: LogStreamTarget, opts?: {
    tail?: number | null
    maxLines?: number | null
    range?: { from: number; to: number } | null
    since?: number | null
    until?: number | null
  }) => {
    lines: string[]
    totalLines: number
    matchedLines: number
    oldestTs: string | null
    newestTs: string | null
    truncated: boolean
  }
  /**
   * Per-WS stream registry. Holds the open `readFile`/`writeFile`
   * transfers for this session — both incoming (chunks arrive as
   * binary WS frames, get written to a host Writable) and outgoing
   * (chunks leave a host Readable, ride out as binary frames).
   *
   * Set by the server when constructing the dispatch context.
   * Handlers `register` an entry when the RPC opens a stream and
   * await the `closed` promise to finalise the response.
   */
  streams?: StreamRegistry
}

/**
 * Thrown by `dispatch` when the caller asked for shutdown. The server
 * catches this and runs the teardown sequence.
 */
export class ShutdownSignal extends Error {
  constructor() {
    super('shutdown requested')
    this.name = 'ShutdownSignal'
  }
}

/**
 * Wraps a typed RpcError that should be forwarded verbatim to the
 * client. `dispatch` throws this for handler errors so the server can
 * distinguish "bad request" from "internal bug" — the former surfaces
 * with the handler's original code (e.g. -32602 InvalidParams), the
 * latter as -32603.
 */
export class RpcHandlerError extends Error {
  constructor(public readonly rpc: RpcError) {
    super(rpc.message)
    this.name = 'RpcHandlerError'
  }
}

/**
 * Dispatch one parsed request. Returns the handler's result value
 * (typed as the union {@link RpcResult}). Throws
 * {@link ShutdownSignal} for the `shutdown` RPC and
 * {@link RpcHandlerError} for any other handler error so the server
 * can react (the policy is: any handler error → shut the daemon down).
 */
export async function dispatch(
  ctx: DispatchContext,
  req: RpcRequest,
): Promise<RpcResult> {
  try {
    return await route(ctx, req.method, req.params)
  } catch (e) {
    if (e instanceof ShutdownSignal) throw e
    throw new RpcHandlerError(errorToRpc(e))
  }
}

/** Set of every valid method name — used by the server to narrow a wire-string `method` to {@link RpcMethod}. */
const KNOWN_METHODS: ReadonlySet<string> = new Set<RpcMethod>([
  'ping',
  'startServer',
  'stopServer',
  'readFile',
  'writeFile',
  'streamEnd',
  'executeRawCommand',
  'attachLog',
  'unattach',
  'shutdown',
  'getActiveConfig',
  'getBuildOutputTree',
  'readBuildLog',
  'readTestLog',
  'readServerLog',
  'getWatchedFiles',
  'publishConfig',
  'publishLog',
  'publishRebuild',
  'getRebuildState',
  'publishWatcherStatus',
  'getWatcherStatus',
  'publishTriggerBuild',
])

/** Narrow a parsed-wire method string to {@link RpcMethod}, throwing on unknown. */
export function narrowMethod(method: string): RpcMethod {
  if (!KNOWN_METHODS.has(method)) {
    throw rpcError(RpcErrorCode.MethodNotFound, `Unknown method: ${method}`)
  }
  return method as RpcMethod
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Internal method→handler dispatch. Each case returns the typed result
 * for that method; the union via `RpcMethodResult[M]` keeps the
 * `dispatch<M>(req)` signature typesafe end-to-end.
 */
async function route(
  ctx: DispatchContext,
  method: RpcMethod,
  params: unknown,
): Promise<RpcResult> {
  // Exhaustiveness check at the bottom catches new methods without a
  // case here at compile time.
  switch (method) {
    case 'ping':
      return handlePing(ctx)
    case 'startServer':
      return handleStartServer()
    case 'stopServer':
      return handleStopServer(params)
    case 'readFile':
      return handleReadFile(ctx, params)
    case 'writeFile':
      return handleWriteFile(ctx, params)
    case 'streamEnd':
      return handleStreamEnd(ctx, params)
    case 'executeRawCommand':
      return handleExecuteRawCommand(params)
    case 'attachLog':
      return handleAttachLog(ctx, params)
    case 'unattach':
      return handleUnattach(ctx, params)
    case 'getActiveConfig':
      return handleGetActiveConfig(ctx)
    case 'getBuildOutputTree':
      return handleGetBuildOutputTree(ctx, params)
    case 'readBuildLog':
      return handleReadBuildLog(ctx, params)
    case 'readTestLog':
      return handleReadTestLog(ctx, params)
    case 'readServerLog':
      return handleReadServerLog(ctx, params)
    case 'getWatchedFiles':
      return handleGetWatchedFiles(ctx)
    case 'publishConfig':
      return handlePublishConfig(ctx, params)
    case 'publishLog':
      return handlePublishLog(ctx, params)
    case 'publishRebuild':
      return handlePublishRebuild(ctx, params)
    case 'getRebuildState':
      return handleGetRebuildState(ctx)
    case 'publishWatcherStatus':
      return handlePublishWatcherStatus(ctx, params)
    case 'getWatcherStatus':
      return handleGetWatcherStatus(ctx)
    case 'publishTriggerBuild':
      return handlePublishTriggerBuild(ctx)
    case 'shutdown':
      throw new ShutdownSignal()
    default: {
      const _exhaustive: never = method
      void _exhaustive
      throw rpcError(RpcErrorCode.MethodNotFound, `Unknown method: ${method as string}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePing(ctx: DispatchContext): Promise<PingResult> {
  const caps = capabilitiesToRecord(ctx.host.capabilities)
  return {
    protocol: PROTOCOL_VERSION,
    hostType: ctx.host.type,
    displayName: ctx.host.displayName,
    capabilities: caps,
    pid: process.pid,
    uptimeMs: Date.now() - ctx.startedAt,
  }
}

async function handleStartServer(): Promise<void> {
  if (!capable(Capability.StartServer)) throw new UnsupportedCapabilityRpc(Capability.StartServer)
  await runHost((h) => (h.startServer ?? notImplemented(Capability.StartServer)).bind(h)())
}

async function handleStopServer(params: unknown): Promise<void> {
  if (!capable(Capability.StopServer)) throw new UnsupportedCapabilityRpc(Capability.StopServer)
  // Reset the flag from any prior cycle before re-arming. The flag
  // covers ALL member disconnects during the cycle — without the
  // reset, a leftover `true` from a prior run would suppress
  // disconnect handling for an unrelated later event.
  setExpectedShutdown(false)
  // Mark the imminent disconnect as expected so the host-lost
  // watcher leaves the daemon alive. Covers MCP `restartServer`,
  // `runServerCommand("stop")` (which routes here), etc.
  setExpectedShutdown(true)
  // Optional `{ timeoutSeconds?: number }`. We only forward it to the
  // provider if the config supports it — today no provider does, so the
  // field is parsed but ignored. Documented as a forward-compatible
  // hint.
  void (params as StopServerParams | undefined)
  await runHost((h) => (h.stopServer ?? notImplemented(Capability.StopServer)).bind(h)())
}

async function handleReadFile(ctx: DispatchContext, params: unknown): Promise<ReadFileResult> {
  if (!capable(Capability.ReadFile)) throw new UnsupportedCapabilityRpc(Capability.ReadFile)
  const { path } = parseParams<ReadFileParams>(params, ['path'])
  // Streaming only — the host must implement `readFileStream`.
  if (!ctx.streams) throw rpcError(RpcErrorCode.InternalError, 'Server has no stream registry')
  const streamInfo = await runHost<{ stream: ReadableStream<Uint8Array>; size?: number }>((h) => {
    if (!h.readFileStream) {
      throw new UnsupportedCapabilityRpc('readFileStream')
    }
    return Promise.resolve(h.readFileStream(path as ServerPath))
  })
  const streamId = streamIdHex(newStreamId())
  const ws = ctx.ws as { send(data: Uint8Array): void } | undefined
  // `onClose` bridges registry close events back to the WS
  // transport. Fires for every close path (success, error,
  // session-close) so the streamEnd envelope is sent exactly once
  // without callers having to remember.
  const record = ctx.streams.open({
    streamId,
    direction: 'incoming',
    kind: 'readFile',
    onClose: (bytes, err) => {
      try {
        if (err) {
          // Host read failed — surface to the consumer instead of
          // silently closing the stream. Client dispatches by
          // streamId, errors its ReadableStream controller (if
          // any) so the consumer's reader loop rejects, and rejects
          // any pending resolvers.
          ws?.send(encodeRpc(event('streamError', {
            streamId,
            code: 0,
            message: err.message,
          })))
        } else {
          ws?.send(encodeRpc(event('streamEnd', { streamId, bytes })))
        }
      } catch {
        // Peer disconnected mid-close.
      }
    },
  })
  if (ws) {
    const reader = streamInfo.stream.getReader()
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          record.bytes += value.byteLength
          try { ws.send(encodeStreamChunk(hexToBytes(streamId), value)) } catch { /* disconnected */ }
        }
        ctx.streams!.close(streamId, record.bytes)
      } catch (err) {
        ctx.streams!.close(
          streamId,
          record.bytes,
          err instanceof Error ? err : new Error(String(err)),
        )
      }
    })()
  }
  return { streamId, totalSize: streamInfo.size }
}

async function handleWriteFile(ctx: DispatchContext, params: unknown): Promise<WriteFileResult> {
  if (!capable(Capability.WriteFile)) throw new UnsupportedCapabilityRpc(Capability.WriteFile)
  const { path, size } = parseParams<WriteFileParams>(params, ['path'])
  // Streaming only — the host must implement `writeFileStream`.
  if (!ctx.streams) throw rpcError(RpcErrorCode.InternalError, 'Server has no stream registry')
  const sink = await runHost<WritableStream<Uint8Array>>((h) => {
    if (!h.writeFileStream) {
      throw new UnsupportedCapabilityRpc('writeFileStream')
    }
    return Promise.resolve(h.writeFileStream(path as ServerPath, size !== undefined ? { size } : undefined))
  })
  const streamId = streamIdHex(newStreamId())
  const ws = ctx.ws as { send(data: Uint8Array): void } | undefined
  ctx.streams.open({
    streamId,
    direction: 'incoming',
    kind: 'writeFile',
    // Send `streamEnd` once the host writer has been finalised.
    // Reached via the client's `streamEnd` notification
    // (handleStreamEnd → streams.close) OR via the binary handler's
    // writer-write error catch OR via the session-close cascade.
    // On `err` we send a `streamError` envelope instead so the
    // client surfaces the host failure to the caller instead of
    // letting `result.done` resolve as if the write succeeded.
    onClose: (bytes, err) => {
      try {
        if (err) {
          ws?.send(encodeRpc(event('streamError', {
            streamId,
            code: 0,
            message: err.message,
          })))
        } else {
          ws?.send(encodeRpc(event('streamEnd', { streamId, bytes })))
        }
      } catch {
        // Peer disconnected mid-close.
      }
    },
  })
  ctx.streams.attachWriter(streamId, sink.getWriter())
  return { streamId }
}

/**
 * Handle `streamEnd` — sent by the WS peer to signal the end of an
 * outgoing stream they own. We close the corresponding registry
 * entry (which closes the host stream via the registered `onClose`
 * callback that fans the matching `streamEnd` envelope back).
 */
async function handleStreamEnd(ctx: DispatchContext, params: unknown): Promise<void> {
  if (!ctx.streams) throw rpcError(RpcErrorCode.InternalError, 'Server has no stream registry')
  const { streamId, bytes } = parseParams<{ streamId: string; bytes?: number }>(params, ['streamId'])
  // The client doesn't track per-stream bytes — it sends 0 as a
  // placeholder. Read the server-side accumulator so the envelope
  // we fan back carries the real count.
  const finalBytes = ctx.streams.get(streamId)?.bytes ?? bytes ?? 0
  ctx.streams.close(streamId, finalBytes)
}

async function handleExecuteRawCommand(params: unknown): Promise<ExecuteRawCommandResult> {
  if (!capable(Capability.ExecuteRawCommand)) throw new UnsupportedCapabilityRpc(Capability.ExecuteRawCommand)
  const { command } = parseParams<ExecuteRawCommandParams>(params, ['command'])
  // `stop` triggers an intentional MC server shutdown. Mark the
  // imminent disconnect as expected so the host-lost watcher leaves
  // the daemon alive. Set BEFORE delegating to the host so the JVM
  // exit (triggered by `stop` reaching the server) doesn't race us.
  if (command.trim().toLowerCase() === 'stop') {
    setExpectedShutdown(true)
  }
  const output = await runHost<string>((h) =>
    (h.executeRawCommand ?? notImplemented(Capability.ExecuteRawCommand)).bind(h)(command),
  )
  return { output }
}

async function handleAttachLog(ctx: DispatchContext, params: unknown): Promise<AttachLogResult> {
  if (!capable(Capability.AttachLog)) throw new UnsupportedCapabilityRpc(Capability.AttachLog)
  const { regex } = parseParams<AttachLogParams>(params, [])
  const filter = regex ? new RegExp(regex) : null

  // Generate the wire subscription id BEFORE wiring the handler so the
  // handler's pushLog calls can tag batches with it. The host's attachLog
  // returns its own subscription handle, but the wire identifier the
  // client sees comes from our registry.
  const subscriptionId = ctx.subscriptions.registerWithId(
    crypto.randomUUID(),
    ctx.ws,
    // Placeholder — replaced once attachLog resolves. If unattach is
    // called before then (extremely unlikely), the registry will just
    // try to no-op the dangling record.
    async () => {},
  )

  // We hand the host a handler that pushes through the per-ws coalescer.
  // That way every consumer gets the same coalesced + filtered stream
  // and the host stays oblivious to N subscribers.
  const handler: LogChunkHandler = (lines) => {
    if (filter) {
      const matched = lines.filter((l) => filter.test(l))
      if (matched.length > 0) ctx.pushLog(matched, subscriptionId)
    } else {
      ctx.pushLog(lines, subscriptionId)
    }
  }
  const subscription = await runHost((h) =>
    (h.attachLog ?? notImplemented('attachLog')).bind(h)(handler),
  )
  // Replace the placeholder unattach with the real provider thunk so the
  // ws close cascade (dropAllForWs) and explicit `unattach` RPCs both
  // reach the host's subscription.
  ctx.subscriptions.replaceUnattach(subscriptionId, () => subscription.unattach())
  return { subscriptionId }
}

async function handleUnattach(ctx: DispatchContext, params: unknown): Promise<void> {
  const { subscriptionId } = parseParams<UnattachParams>(params, ['subscriptionId'])
  const ok = await ctx.subscriptions.unattach(subscriptionId)
  if (!ok) throw rpcError(RpcErrorCode.UnknownSubscription, `Unknown subscription: ${subscriptionId}`)
}

// ---------------------------------------------------------------------------
// Project-state handlers (consumed by `sand mcp` and other observers)
// ---------------------------------------------------------------------------

async function requireActiveConfig(ctx: DispatchContext): Promise<ActiveConfig> {
  if (!ctx.activeConfig) {
    throw rpcError(
      RpcErrorCode.NotConnected,
      'No active `sandstone.config.ts`. Run `sand connect` from a Sandstone project, or start `sand watch` to publish one.',
    )
  }
  return ctx.activeConfig
}

async function handleGetActiveConfig(ctx: DispatchContext): Promise<GetActiveConfigResult> {
  const cfg = await requireActiveConfig(ctx)
  return {
    mode: cfg.mode,
    configPath: cfg.configPath,
    saveConfig: cfg.saveConfig,
    outputDir: cfg.outputDir,
    projectRoot: cfg.projectRoot,
    loadedAt: cfg.loadedAt,
  }
}

async function handleGetBuildOutputTree(
  ctx: DispatchContext,
  params: unknown,
): Promise<GetBuildOutputTreeResult> {
  const cfg = await requireActiveConfig(ctx)
  const { path: subpath = '', limit = 1000 } = parseParams<GetBuildOutputTreeParams>(params, [])
  return listDirectory(cfg.outputDir, subpath, limit)
}

async function handleReadBuildLog(
  ctx: DispatchContext,
  params: unknown,
): Promise<ReadBuildLogResult> {
  const cfg = await requireActiveConfig(ctx)
  // All six params are present in every wire call (URI template
  // matching requires it). `null` is the wire shape for "no filter"
  // — the MCP resource layer already translated the URI's `-1`
  // sentinel before sending.
  const { tail, maxLines, range, since, until } = parseParams<ReadBuildLogParams>(
    params,
    ['tail', 'maxLines', 'range', 'since', 'until'],
  )
  if (!ctx.readLogBuffer) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon has no log buffer configured')
  }
  const buf = ctx.readLogBuffer('build', { tail, maxLines, range, since, until })
  return {
    path: cfg.logPath,
    lines: buf.lines,
    totalLines: buf.totalLines,
    matchedLines: buf.matchedLines,
    oldestTs: buf.oldestTs,
    newestTs: buf.newestTs,
    truncated: buf.truncated,
  }
}

async function handleReadTestLog(
  ctx: DispatchContext,
  params: unknown,
): Promise<ReadTestLogResult> {
  const { tail, maxLines, range, since, until } = parseParams<ReadBuildLogParams>(
    params,
    ['tail', 'maxLines', 'range', 'since', 'until'],
  )
  if (!ctx.readLogBuffer) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon has no log buffer configured')
  }
  const buf = ctx.readLogBuffer('test', { tail, maxLines, range, since, until })
  // No canonical file path for the test log — return a placeholder so
  // consumers can display a useful hint.
  return {
    path: '<test-runner-buffer>',
    lines: buf.lines,
    totalLines: buf.totalLines,
    matchedLines: buf.matchedLines,
    oldestTs: buf.oldestTs,
    newestTs: buf.newestTs,
    truncated: buf.truncated,
  }
}

async function handleReadServerLog(
  ctx: DispatchContext,
  params: unknown,
): Promise<ReadServerLogResult> {
  const { tail, maxLines, range, since, until } = parseParams<ReadServerLogParams>(
    params,
    ['tail', 'maxLines', 'range', 'since', 'until'],
  )
  if (!ctx.readLogBuffer) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon has no log buffer configured')
  }
  // In-memory buffer populated by the daemon's own attachLog
  // subscription at boot. No file read — the on-disk log is only for
  // humans tailing it directly.
  const buf = ctx.readLogBuffer('server', { tail, maxLines, range, since, until })
  return {
    path: '<host-stdout-buffer>',
    lines: buf.lines,
    totalLines: buf.totalLines,
    matchedLines: buf.matchedLines,
    oldestTs: buf.oldestTs,
    newestTs: buf.newestTs,
    truncated: buf.truncated,
  }
}

async function handlePublishLog(
  ctx: DispatchContext,
  params: unknown,
): Promise<void> {
  if (!ctx.appendLogLines) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to accept log lines')
  }
  const { entries, target } = parseParams<{
    entries: Array<{ line: string; ts: number }>
    target?: LogStreamTarget
  }>(params, ['entries'])
  ctx.appendLogLines(entries, target ?? 'build')
}

async function handlePublishRebuild(
  ctx: DispatchContext,
  params: unknown,
): Promise<void> {
  if (!ctx.setRebuildState) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to track rebuild state')
  }
  if (!ctx.notifyResourceUpdated) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast resource notifications')
  }
  const p = parseParams<RebuildState>(
    params,
    ['state', 'fileCount', 'errorCount', 'warningCount', 'at'],
  )
  // The watcher stamps `at`; trust it. If absent, fall back to "now".
  const state: RebuildState = {
    state: p.state,
    fileCount: p.fileCount,
    errorCount: p.errorCount,
    warningCount: p.warningCount,
    at: p.at ?? new Date().toISOString(),
    ...(p.message !== undefined ? { message: p.message } : {}),
  }
  ctx.setRebuildState(state)
  ctx.notifyResourceUpdated('sandstone://rebuild-state')
}

async function handleGetRebuildState(ctx: DispatchContext): Promise<{ state: RebuildState | null }> {
  if (!ctx.getRebuildState) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to expose rebuild state')
  }
  return { state: ctx.getRebuildState() ?? null }
}

async function handlePublishWatcherStatus(
  ctx: DispatchContext,
  params: unknown,
): Promise<void> {
  if (!ctx.setWatcherStatus) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to track watcher status')
  }
  if (!ctx.notifyResourceUpdated) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast resource notifications')
  }
  const p = parseParams<{
    connected: boolean
    mode: 'pack' | 'library' | null
    manual: boolean
    path: string
    pid: number
    at: string
  }>(params, ['connected', 'mode', 'manual', 'path', 'pid', 'at'])
  ctx.setWatcherStatus({
    connected: p.connected,
    mode: p.mode,
    manual: p.manual,
    path: p.path,
    pid: p.pid,
    at: p.at ?? new Date().toISOString(),
  }, ctx.ws)
  ctx.notifyResourceUpdated('sandstone://watcher-status')
}

async function handleGetWatcherStatus(ctx: DispatchContext): Promise<{ status: WatcherStatus | null }> {
  if (!ctx.getWatcherStatus) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to expose watcher status')
  }
  const status = ctx.getWatcherStatus()
  return { status: status ?? null }
}

async function handlePublishTriggerBuild(ctx: DispatchContext): Promise<{ triggered: boolean }> {
  // Fan a `triggerBuild` event out to every connected session. The
  // watcher subscribes (via `client.onTriggerBuild`) and runs its
  // rebuild path; MCP clients ignore the event.
  if (!ctx.broadcast) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast events')
  }
  ctx.broadcast('triggerBuild', { at: new Date().toISOString() })
  return { triggered: true }
}

async function handlePublishConfig(
  ctx: DispatchContext,
  params: unknown,
): Promise<void> {
  const p = parseParams<{
    mode: 'pack' | 'library'
    configPath: string
    saveConfig: ActiveSaveConfig | undefined
    outputDir: string
    projectRoot: string
    loadedAt: string
  }>(params, ['mode', 'configPath', 'saveConfig', 'outputDir', 'projectRoot', 'loadedAt'])
  if (!ctx.setActiveConfig) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to accept published configs')
  }
  if (!ctx.broadcast) {
    throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast events')
  }
  const next: ActiveConfig = {
    mode: p.mode,
    configPath: p.configPath,
    saveConfig: p.saveConfig,
    outputDir: p.outputDir,
    // Watcher always logs at the project root, not under `test/`.
    logPath: `${p.projectRoot}/.sandstone/watch.log`,
    projectRoot: p.projectRoot,
    loadedAt: p.loadedAt,
  }
  ctx.setActiveConfig(next)
  ctx.broadcast('configChanged', {
    saveConfig: next.saveConfig,
    mode: next.mode,
    configPath: next.configPath,
    detectedAt: new Date().toISOString(),
  })
}

async function handleGetWatchedFiles(_ctx: DispatchContext): Promise<GetWatchedFilesResult> {
  // The daemon doesn't track per-file watcher state itself — the watcher
  // pushes `rebuildComplete` events, not per-file deltas. Return an
  // empty list rather than 501-ing; clients that want fine-grained
  // events should subscribe to `rebuildComplete` and diff the output
  // tree themselves.
  return { files: [] }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let currentHost: HostProvider | null = null
function capable(cap: Capability): boolean {
  if (!currentHost) return false
  return currentHost.capabilities.has(cap)
}

/**
 * Scope `currentHost` for the duration call an `op(host)` so `capable`
 * can read it without threading the host through every helper.
 */
async function runHost<T>(op: (h: HostProvider) => Promise<T>): Promise<T> {
  const host = currentHost
  if (!host) throw rpcError(RpcErrorCode.NotConnected, 'No host available')
  return op(host)
}

/** Set the active host before dispatching; restore on the way out. */
export async function withHost<T>(host: HostProvider, fn: () => Promise<T>): Promise<T> {
  currentHost = host
  try {
    return await fn()
  } finally {
    currentHost = null
  }
}

function parseParams<T extends object>(
  params: unknown,
  required: Array<keyof T>,
): T {
  const obj = (params ?? {}) as Record<string, unknown>
  for (const key of required) {
    if (!(key in obj)) {
      throw rpcError(RpcErrorCode.InvalidParams, `Missing param: ${String(key)}`)
    }
  }
  return obj as T
}

class UnsupportedCapabilityRpc extends Error {
  constructor(public readonly capability: string) {
    super(`Unsupported capability: ${capability}`)
    this.name = 'UnsupportedCapabilityError'
  }
}

function rpcError(code: number, message: string): RpcError {
  return { code, message }
}

function notImplemented(method: string): never {
  throw new Error(`Host advertises capability but does not implement: ${method}`)
}

/**
 * Module-level watcher-ws tracking. Dispatch tracks which WS session is
 * the watcher so `onSessionClose` (called from server.ts's session
 * close hook) can detect disconnects and flip `connected: false`
 * atomically. Lives outside `DispatchContext` because the tracking
 * outlives any single request — the watcher connects once and may
 * publish multiple `publishRebuild` events over its lifetime.
 */
let watcherWs: unknown = undefined

/**
 * Called by the server when ANY WS session closes. If the closing ws
 * is the one that published `WatcherStatus`, flip `connected: false`
 * via `setWatcherStatus(undefined_ws)` and fire a resource notification.
 *
 * Exported so server.ts's session-close handler can call it
 * (the session close happens outside any request — no dispatchCtx).
 */
export function handleSessionClose(ws: unknown, ctx: DispatchContext): void {
  if (watcherWs !== ws) return
  watcherWs = undefined
  if (!ctx.setWatcherStatus || !ctx.getWatcherStatus || !ctx.notifyResourceUpdated) return
  const prev = ctx.getWatcherStatus()
  if (prev === null) return
  ctx.setWatcherStatus({ ...prev, connected: false }, undefined)
  ctx.notifyResourceUpdated('sandstone://watcher-status')
}

// ---------------------------------------------------------------------------
// Project-state helpers (used by the read-only RPC handlers above)
// ---------------------------------------------------------------------------

const MAX_LOG_BYTES_DEFAULT = 256 * 1024
const MAX_LOG_TAIL_DEFAULT = 200
const MAX_DIR_ENTRIES_DEFAULT = 1000

/**
 * List one level of a build output directory. Returns `{path, size, mtime, isDirectory}`
 * for each direct child; non-recursive. `path` is the requested subpath
 * relative to `baseDir` (empty string = the base). `truncated` is set when
 * the result was capped by `limit` so callers can prompt for more.
 *
 * Missing directories return `{entries: [], truncated: false}` — the
 * `sandstone build`/`sand watch` daemon may legitimately have no output
 * yet (first run, clean state).
 */
async function listDirectory(
  baseDir: string,
  subpath: string,
  limit: number,
): Promise<GetBuildOutputTreeResult> {
  const target = resolvePath(baseDir, subpath)
  if (!(await fs.pathExists(target))) {
    return { baseDir, entries: [], truncated: false }
  }
  const cap = Math.max(1, limit ?? MAX_DIR_ENTRIES_DEFAULT)
  const dirents = await fs.readDirEntries(target)
  const entries: BuildOutputEntry[] = []
  for (const d of dirents) {
    if (entries.length >= cap) {
      return { baseDir, entries, truncated: true }
    }
    const full = resolvePath(target, d.name)
    let size = 0
    let mtime: Date
    try {
      const s = await fs.fileStat(full)
      size = d.isDirectory ? 0 : s.size
      mtime = s.mtime
    } catch {
      // File deleted between readdir and stat — skip with a sentinel
      // mtime so the entry still surfaces (caller decides what to do).
      mtime = new Date(0)
    }
    entries.push({
      path: d.name,
      size,
      mtime: mtime.toISOString(),
      isDirectory: d.isDirectory,
    })
  }
  return { baseDir, entries, truncated: false }
}

/**
 * Default cap for the daemon's in-memory build-log buffer.
 * Bound so a long-running watcher doesn't blow up daemon memory.
 */
const MAX_LOG_BUFFER_LINES = 1000