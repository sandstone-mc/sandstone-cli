import { resolve as resolvePath } from 'node:path'

import * as fs from '../../utils/fs.js'

import type * as rpc from './rpc.js'
import { PROTOCOL_VERSION, RpcErrorCode, errorToRpc } from './rpc.js'
import type { SubscriptionRegistry } from './subscriptions.js'
import type { StreamRegistry } from './streams.js'
import { encodeStreamChunk, hexToBytes, newStreamId, streamIdHex } from './codec.js'
import { Capability, capabilitiesToRecord } from '../../hosts/types.js'
import type { HostProvider, LogChunkHandler, ServerPath } from '../../hosts/types.js'
import type { ActiveConfig } from './active-config.js'
import { setExpectedShutdown } from './daemon.js'
import { UnsupportedCapabilityRpc, rpcError } from './host-capability.js'
import { makeStreamEndBridge } from './stream-bridge.js'
import { WsData } from './server.js'

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
  constructor(public readonly rpc: rpc.RpcError) {
    super(rpc.message)
    this.name = 'RpcHandlerError'
  }
}

const MAX_DIR_ENTRIES_DEFAULT = 1000

export class DispatcherContext {
  constructor(
    public readonly host: HostProvider,
    public readonly subscriptions: SubscriptionRegistry,
    public readonly ws: Bun.ServerWebSocket<WsData>,
    public readonly pushLog: (lines: string[], subscriptionId: string) => void,
    public readonly startedAt: number,
    /**
     * Live snapshot getter — callers pass `() => opts.getActiveConfig?.()`
     * so handlers always see the latest value (the watcher may hot-reload
     * via `publishConfig` mid-session).
     */
    public readonly getActiveConfig: () => ActiveConfig | undefined,
    public readonly broadcast?: (eventName: string, data: unknown) => void,
    public readonly notifyResourceUpdated?: (uri: string) => void,
    public readonly setActiveConfig?: (cfg: ActiveConfig) => void,
    public readonly getRebuildState?: () => rpc.RebuildState | undefined,
    public readonly setRebuildState?: (state: rpc.RebuildState) => void,
    public readonly getWatcherStatus?: () => rpc.WatcherStatus | null,
    public readonly setWatcherStatus?: (status: rpc.WatcherStatus, ws: Bun.ServerWebSocket<WsData> | undefined) => void,
    public readonly getExpectedShutdown?: () => boolean,
    public readonly appendLogLines?: (entries: rpc.LogLineEntry[], target: rpc.LogStreamTarget) => void,
    public readonly readLogBuffer?: (target: rpc.LogStreamTarget, opts?: {
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
    },
    public readonly streams?: StreamRegistry,
  ) {}

}

export class DispatcherInternals {
  readonly context: DispatcherContext

  constructor(public readonly dispatcher: Dispatcher, context: DispatcherContext) {
    this.context = context
  }

  get host() { return this.context.host }
  get subscriptions() { return this.context.subscriptions }
  get ws() { return this.context.ws }
  get pushLog() { return this.context.pushLog }
  get startedAt() { return this.context.startedAt }
  get activeConfig() { return this.context.getActiveConfig() }
  get broadcast() { return this.context.broadcast }
  get notifyResourceUpdated() { return this.context.notifyResourceUpdated }
  get setActiveConfig() { return this.context.setActiveConfig }
  get getRebuildState() { return this.context.getRebuildState }
  get setRebuildState() { return this.context.setRebuildState }
  get getWatcherStatus() { return this.context.getWatcherStatus }
  get setWatcherStatus() { return this.context.setWatcherStatus }
  get getExpectedShutdown() { return this.context.getExpectedShutdown }
  get appendLogLines() { return this.context.appendLogLines }
  get readLogBuffer() { return this.context.readLogBuffer }
  get streams() { return this.context.streams }

  runHost<T>(op: (h: HostProvider) => Promise<T>): Promise<T> {
    const host = Dispatcher.currentHost
    if (!host) throw rpcError(RpcErrorCode.NotConnected, 'No host available')
    return op(host)
  }

  async requireActiveConfig(): Promise<ActiveConfig> {
    if (!this.activeConfig) {
      throw rpcError(
        RpcErrorCode.NotConnected,
        'No active `sandstone.config.ts`. Run `sand connect` from a Sandstone project, or start `sand watch` to publish one.',
      )
    }
    return this.activeConfig
  }

  parseParams<T extends object>(params: unknown, required: Array<keyof T>): T {
    const obj = (params ?? {}) as Record<string, unknown>
    for (const key of required) {
      if (!(key in obj)) {
        throw rpcError(RpcErrorCode.InvalidParams, `Missing param: ${String(key)}`)
      }
    }
    return obj as T
  }

  async readBufferLog(
    params: rpc.ReadBuildLogParams | undefined,
    target: 'build' | 'test' | 'server',
  ): Promise<rpc.ReadBuildLogResult | rpc.ReadTestLogResult | rpc.ReadServerLogResult> {
    const { tail, maxLines, range, since, until } = this.parseParams<rpc.ReadBuildLogParams>(
      params,
      ['tail', 'maxLines', 'range', 'since', 'until'],
    )
    if (!this.readLogBuffer) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon has no log buffer configured')
    }
    const buf = this.readLogBuffer(target, { tail, maxLines, range, since, until })
    const cfg = await this.requireActiveConfig()
    const path = target === 'build' ? cfg.logPath : target === 'test' ? '<test-runner-buffer>' : '<host-stdout-buffer>'
    return {
      path,
      lines: buf.lines,
      totalLines: buf.totalLines,
      matchedLines: buf.matchedLines,
      oldestTs: buf.oldestTs,
      newestTs: buf.newestTs,
      truncated: buf.truncated,
    }
  }

  async readLogFile(path: string): Promise<string[]> {
    try {
      const text = await fs.readText(path)
      const lines = text.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      return lines
    } catch (err) {
      // Re-throw with the file path for diagnosability.
      throw new Error(
        `Failed to read log at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async listDirectory(
    baseDir: string,
    subpath: string,
    limit: number,
  ): Promise<rpc.GetBuildOutputTreeResult> {
    const target = resolvePath(baseDir, subpath)
    if (!(await fs.pathExists(target))) {
      return { baseDir, entries: [], truncated: false }
    }
    const cap = Math.max(1, limit ?? MAX_DIR_ENTRIES_DEFAULT)
    const dirents = await fs.readDirEntries(target)
    const truncated = dirents.length > cap
    const entries: rpc.BuildOutputEntry[] = dirents.slice(0, cap).map((d) => ({
      path: d.name,
      isDirectory: d.isDirectory,
    }))
    return { baseDir, entries, truncated }
  }
}

export class Dispatcher {
  static currentHost: HostProvider | null = null

  /**
   * Single protected field holding every non-API helper — params
   * parsing, host scoping, log buffering, file IO, etc. Keeps the
   * public class surface limited to the RPC method names.
   */
  protected readonly internals: DispatcherInternals

  constructor(ctx: DispatcherContext) {
    // Pass the caller's `getActiveConfig` closure straight through so
    // handlers always see the latest snapshot (the watcher may
    // hot-reload the config mid-session via `publishConfig`).
    const context = new DispatcherContext(
      ctx.host,
      ctx.subscriptions,
      ctx.ws,
      ctx.pushLog,
      ctx.startedAt,
      ctx.getActiveConfig ?? (() => undefined),
      ctx.broadcast,
      ctx.notifyResourceUpdated,
      ctx.setActiveConfig,
      ctx.getRebuildState,
      ctx.setRebuildState,
      ctx.getWatcherStatus,
      ctx.setWatcherStatus,
      ctx.getExpectedShutdown,
      ctx.appendLogLines,
      ctx.readLogBuffer,
      ctx.streams,
    )
    this.internals = new DispatcherInternals(this, context)
  }

  // ─── host scoping ──────────────────────────────────────────────

  /**
   * Scope the active host for the duration of `fn` so handlers can
   * reach it via `internals.runHost`. Set BEFORE delegating so a JVM
   * exit (triggered by e.g. `stop` reaching the server) doesn't race.
   */
  static async withHost<T>(host: HostProvider, fn: () => Promise<T>): Promise<T> {
    Dispatcher.currentHost = host
    try {
      return await fn()
    } finally {
      Dispatcher.currentHost = null
    }
  }

  // ─── RPC handlers (typed via `rpc.ts`) ─────────────────────────

  async ping(_params: undefined): Promise<rpc.PingResult> {
    const caps = capabilitiesToRecord(this.internals.host.capabilities)
    return {
      protocol: PROTOCOL_VERSION,
      hostType: this.internals.host.type,
      displayName: this.internals.host.displayName,
      capabilities: caps,
      pid: process.pid,
      uptimeMs: Date.now() - this.internals.startedAt,
    }
  }

  async startServer(_params: undefined): Promise<void> {
    await this.internals.runHost(async (h) => {
      if (!h.startServer) throw new UnsupportedCapabilityRpc(Capability.StartServer)
      await h.startServer()
    })
  }

  async stopServer(params: rpc.StopServerParams | undefined): Promise<void> {
    // Reset the flag from any prior cycle before re-arming. The flag
    // covers ALL member disconnects during the cycle — without the
    // reset, a leftover `true` from a prior run would suppress
    // disconnect handling for an unrelated later event.
    setExpectedShutdown(false)
    // Mark the imminent disconnect as expected so the host-lost
    // watcher leaves the daemon alive. Covers MCP `restartServer`,
    // `runServerCommand("stop")` (which routes here), etc.
    setExpectedShutdown(true)
    await this.internals.runHost(async (h) => {
      if (!h.stopServer) throw new UnsupportedCapabilityRpc(Capability.StopServer)
      await h.stopServer()
    })
    // Touch `params` so the typed signature is acknowledged; the
    // daemon ignores the timeout today (host has its own) but the
    // wire shape accepts it for forward compat.
    void params
  }

  async readFile(params: rpc.ReadFileParams): Promise<rpc.RpcReadFileStream> {
    const ctx = this.internals
    if (!ctx.streams) throw rpcError(RpcErrorCode.InternalError, 'Server has no stream registry')
    const streamInfo = await this.internals.runHost<{ stream: ReadableStream<Uint8Array>; size?: number }>(
      async (h) => {
        if (!h.readFileStream) throw new UnsupportedCapabilityRpc('readFileStream')
        return h.readFileStream(params.path as ServerPath)
      },
    )
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
      onClose: makeStreamEndBridge(ws, streamId),
    })
    if (ws) {
      const reader = streamInfo.stream.getReader();
      (async () => {
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

  async writeFile(params: rpc.WriteFileParams): Promise<rpc.WriteFileResult> {
    const ctx = this.internals
    if (!ctx.streams) throw rpcError(RpcErrorCode.InternalError, 'Server has no stream registry')
    const sink = await this.internals.runHost<WritableStream<Uint8Array>>(async (h) => {
      if (!h.writeFileStream) throw new UnsupportedCapabilityRpc('writeFileStream')
      return h.writeFileStream(params.path as ServerPath, params.size !== undefined ? { size: params.size } : undefined)
    })
    const streamId = streamIdHex(newStreamId())
    const ws = ctx.ws as { send(data: Uint8Array): void } | undefined
    ctx.streams.open({
      streamId,
      direction: 'incoming',
      kind: 'writeFile',
      // `onClose` bridges registry close events back to the WS
      // transport. Reached via the client's `streamEnd` notification
      // OR via the binary handler's writer-write error catch OR via
      // the session-close cascade.
      onClose: makeStreamEndBridge(ws, streamId),
    })
    ctx.streams.attachWriter(streamId, sink.getWriter())
    return { streamId }
  }

  /**
   * `streamEnd` — sent by the WS peer to signal the end of an
   * outgoing stream they own. We close the corresponding registry
   * entry (which closes the host stream via the registered `onClose`
   * callback that fans the matching `streamEnd` envelope back).
   */
  async streamEnd(params: { streamId: string; bytes?: number }): Promise<void> {
    const ctx = this.internals
    if (!ctx.streams) throw rpcError(RpcErrorCode.InternalError, 'Server has no stream registry')
    // The client doesn't track per-stream bytes — it sends 0 as a
    // placeholder. Read the server-side accumulator so the envelope
    // we fan back carries the real count.
    const finalBytes = ctx.streams.get(params.streamId)?.bytes ?? params.bytes ?? 0
    ctx.streams.close(params.streamId, finalBytes)
  }

  async executeRawCommand(params: rpc.ExecuteRawCommandParams): Promise<rpc.ExecuteRawCommandResult> {
    // `stop` triggers an intentional MC server shutdown. Mark the
    // imminent disconnect as expected so the host-lost watcher leaves
    // the daemon alive. Set BEFORE delegating to the host so the JVM
    // exit (triggered by `stop` reaching the server) doesn't race us.
    if (params.command.trim().toLowerCase() === 'stop') {
      setExpectedShutdown(true)
    }
    const output = await this.internals.runHost<string>(async (h) => {
      if (!h.executeRawCommand) throw new UnsupportedCapabilityRpc(Capability.ExecuteRawCommand)
      return h.executeRawCommand(params.command)
    })
    return { output }
  }

  async attachLog(params: rpc.AttachLogParams | undefined): Promise<rpc.AttachLogResult> {
    const filter = params?.regex ? new RegExp(params.regex) : null
    const ctx = this.internals

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
    const subscription = await this.internals.runHost(async (h) => {
      if (!h.attachLog) throw new UnsupportedCapabilityRpc('attachLog')
      return h.attachLog(handler)
    })
    // Replace the placeholder unattach with the real provider thunk so the
    // ws close cascade (dropAllForWs) and explicit `unattach` RPCs both
    // reach the host's subscription.
    ctx.subscriptions.replaceUnattach(subscriptionId, () => subscription.unattach())
    return { subscriptionId }
  }

  async unattach(params: rpc.UnattachParams): Promise<void> {
    const ok = await this.internals.subscriptions.unattach(params.subscriptionId)
    if (!ok) throw rpcError(RpcErrorCode.UnknownSubscription, `Unknown subscription: ${params.subscriptionId}`)
  }

  // ─── project-state handlers (consumed by `sand mcp` and other observers) ──

  async getActiveConfig(_params: undefined): Promise<rpc.GetActiveConfigResult> {
    const cfg = await this.internals.requireActiveConfig()
    const clientPath = cfg.saveConfig?.clientPath
    return {
      mode: cfg.mode,
      configPath: cfg.configPath,
      saveConfig: cfg.saveConfig,
      // The intrinsic client-log RPC can serve a log iff
      // `saveConfig.clientPath` is configured. The actual file may
      // still be missing at read time — the RPC surfaces that — but
      // availability here lets tools advertise / pre-check before
      // attempting the read.
      clientLogAvailable: typeof clientPath === 'string' && clientPath.length > 0,
      outputDir: cfg.outputDir,
      projectRoot: cfg.projectRoot,
      loadedAt: cfg.loadedAt,
    }
  }

  async getBuildOutputTree(params: rpc.GetBuildOutputTreeParams | undefined): Promise<rpc.GetBuildOutputTreeResult> {
    const cfg = await this.internals.requireActiveConfig()
    const subpath = params?.path ?? ''
    const limit = params?.limit ?? 1000
    return this.internals.listDirectory(cfg.outputDir, subpath, limit)
  }

  async readBuildLog(params: rpc.ReadBuildLogParams | undefined): Promise<rpc.ReadBuildLogResult> {
    return this.internals.readBufferLog(params, 'build') as Promise<rpc.ReadBuildLogResult>
  }

  async readTestLog(params: rpc.ReadBuildLogParams | undefined): Promise<rpc.ReadTestLogResult> {
    return this.internals.readBufferLog(params, 'test') as Promise<rpc.ReadTestLogResult>
  }

  async readServerLog(params: rpc.ReadServerLogParams | undefined): Promise<rpc.ReadServerLogResult> {
    return this.internals.readBufferLog(params, 'server') as Promise<rpc.ReadServerLogResult>
  }

  /**
   * Read the Minecraft client launcher log — intrinsic daemon capability,
   * NOT a host provider feature. The daemon reads directly from the
   * configured `clientPath/logs/latest.log` (resolved via the active
   * sandstone.config.ts) since the launcher lives on the machine the
   * daemon runs on, regardless of where the MC server itself runs.
   *
   * Streams the file via `fs.createReadStream` + `TextDecoder(stream:
   * true)` so multi-MB log files don't materialise in memory before
   * filtering. Tail / maxLines / range filter the resulting line array.
   */
  async readClientLog(params: rpc.ReadClientLogParams | undefined): Promise<rpc.ReadClientLogResult> {
    const cfg = await this.internals.requireActiveConfig()
    const clientPath = cfg.saveConfig?.clientPath
    if (!clientPath) {
      throw rpcError(
        RpcErrorCode.InvalidParams,
        'No `saveConfig.clientPath` configured in sandstone.config.ts',
      )
    }
    const tail = params?.tail ?? null
    const maxLines = params?.maxLines ?? null
    const range = params?.range ?? null
    const logPath = `${clientPath}/logs/latest.log`
    const lines = await this.internals.readLogFile(logPath)
    const totalLines = lines.length

    // Range filter: `0` = most recent line in the file. Negative
    // counts from the end (per the existing log RPC conventions).
    let selected = lines
    if (range && range.from !== -1 && range.to !== -1) {
      const len = selected.length
      const startIdx = len - 1 - Math.min(range.from, len - 1)
      const endIdx = len - 1 - Math.min(range.to, len - 1)
      const lo = Math.max(0, Math.min(startIdx, endIdx))
      const hi = Math.min(len - 1, Math.max(startIdx, endIdx))
      selected = selected.slice(lo, hi + 1)
    }
    const matchedLines = selected.length

    // Tail / maxLines cap the final slice.
    const want = tail ?? maxLines ?? 200
    const truncated = selected.length > want
    const finalLines = truncated ? selected.slice(-want) : selected

    return {
      path: logPath,
      lines: finalLines,
      totalLines,
      matchedLines,
      truncated,
    }
  }

  async getWatchedFiles(_params: undefined): Promise<rpc.GetWatchedFilesResult> {
    // The daemon doesn't track per-file watcher state itself — the watcher
    // pushes `rebuildComplete` events, not per-file deltas. Return an
    // empty list rather than 501-ing; clients that want fine-grained
    // events should subscribe to `rebuildComplete` and diff the output
    // tree themselves.
    return { files: [] }
  }

  async publishConfig(params: rpc.PublishConfigParams): Promise<void> {
    const ctx = this.internals
    if (!ctx.setActiveConfig) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to accept published configs')
    }
    if (!ctx.broadcast) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast events')
    }
    const next: ActiveConfig = {
      mode: params.mode,
      configPath: params.configPath,
      saveConfig: params.saveConfig,
      outputDir: params.outputDir,
      // Watcher always logs at the project root, not under `test/`.
      logPath: `${params.projectRoot}/.sandstone/watch.log`,
      projectRoot: params.projectRoot,
      loadedAt: params.loadedAt,
    }
    ctx.setActiveConfig(next)
    ctx.broadcast('configChanged', {
      saveConfig: next.saveConfig,
      mode: next.mode,
      configPath: next.configPath,
      detectedAt: new Date().toISOString(),
    })
  }

  async publishLog(params: rpc.PublishLogParams): Promise<void> {
    const ctx = this.internals
    if (!ctx.appendLogLines) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to accept log lines')
    }
    ctx.appendLogLines(params.entries, params.target ?? 'build')
  }

  async publishRebuild(params: rpc.PublishRebuildParams): Promise<void> {
    const ctx = this.internals
    if (!ctx.setRebuildState) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to track rebuild state')
    }
    if (!ctx.notifyResourceUpdated) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast resource notifications')
    }
    // The watcher stamps `at`; trust it. If absent, fall back to "now".
    const state: rpc.RebuildState = {
      state: params.state,
      fileCount: params.fileCount,
      errorCount: params.errorCount,
      warningCount: params.warningCount,
      at: params.at ?? new Date().toISOString(),
      ...(params.message !== undefined ? { message: params.message } : {}),
    }
    ctx.setRebuildState(state)
    ctx.notifyResourceUpdated('sandstone://rebuild-state')
  }

  async getRebuildState(_params: undefined): Promise<rpc.GetRebuildStateResult> {
    const ctx = this.internals
    if (!ctx.getRebuildState) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to expose rebuild state')
    }
    return { state: ctx.getRebuildState() ?? null }
  }

  async publishWatcherStatus(params: rpc.PublishWatcherStatusParams): Promise<void> {
    const ctx = this.internals
    if (!ctx.setWatcherStatus) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to track watcher status')
    }
    if (!ctx.notifyResourceUpdated) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast resource notifications')
    }
    ctx.setWatcherStatus({
      connected: params.connected,
      mode: params.mode,
      manual: params.manual,
      path: params.path,
      pid: params.pid,
      at: params.at ?? new Date().toISOString(),
    }, ctx.ws)
    ctx.notifyResourceUpdated('sandstone://watcher-status')
  }

  async getWatcherStatus(_params: undefined): Promise<rpc.GetWatcherStatusResult> {
    const ctx = this.internals
    if (!ctx.getWatcherStatus) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to expose watcher status')
    }
    const status = ctx.getWatcherStatus()
    return { status: status ?? null }
  }

  async publishTriggerBuild(_params: undefined): Promise<rpc.PublishTriggerBuildResult> {
    // Fan a `triggerBuild` event out to every connected session. The
    // watcher subscribes (via `client.onTriggerBuild`) and runs its
    // rebuild path; MCP clients ignore the event.
    const ctx = this.internals
    if (!ctx.broadcast) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast events')
    }
    ctx.broadcast('triggerBuild', { at: new Date().toISOString() })
    return { triggered: true }
  }
}

// ---------------------------------------------------------------------------
// Backwards-compatible exports (server.ts + tests still use these)
// ---------------------------------------------------------------------------

/**
 * Methods on `Dispatcher.prototype` that are NOT RPC handlers — the
 * RPC-name set is derived at runtime from the prototype, minus these
 * private helpers. Keep this list in sync when adding new private
 * helpers to the class.
 */
const NON_RPC_METHODS = new Set([
  'constructor',
])

/** Set of every valid method name — used by the server to narrow a wire-string `method` to {@link RpcMethod}. */
const KNOWN_METHODS: ReadonlySet<keyof Dispatcher | 'shutdown'> = new Set([
  ...Object.getOwnPropertyNames(Dispatcher.prototype).filter((n) => !NON_RPC_METHODS.has(n)),
  'shutdown',
] as Array<keyof Dispatcher | 'shutdown'>)

/** Narrow a parsed-wire method string to {@link RpcMethod}, throwing on unknown. */
export function narrowMethod(method: string): rpc.RpcMethod {
  if (!KNOWN_METHODS.has(method as keyof Dispatcher | 'shutdown')) {
    throw rpcError(RpcErrorCode.MethodNotFound, `Unknown method: ${method}`)
  }
  return method as rpc.RpcMethod
}

/**
 * Dispatch one parsed request. Returns the handler's result value,
 * fully typesafe end-to-end — `Method` narrows `params` to the
 * matching `rpc.XxxParams` and the return type to `rpc.XxxResult`.
 * Throws {@link ShutdownSignal} for the `shutdown` method and
 * {@link RpcHandlerError} for any handler error so the server can
 * react.
 */
export async function dispatch<Method extends rpc.RpcMethod>(
  dispatcher: Dispatcher,
  method: Method,
  params: Parameters<Dispatcher[Extract<Method, keyof Dispatcher>]>[0],
) {
  if (method === 'shutdown') throw new ShutdownSignal()
  try {
    // Cast the dispatcher to a method-shaped object keyed by `method`
    // so the call resolves to the matching typed handler signature
    // — params type and return type both narrow in lockstep with
    // `method`. The runtime call is identical to
    // `dispatcher[method](params)`.
    type TypedHandler = {
      [M in Extract<Method, keyof Dispatcher>]: (
        p: Parameters<Dispatcher[M]>[0],
      ) => ReturnType<Dispatcher[M]>
    }
    return await (dispatcher as unknown as TypedHandler)[method as Extract<Method, keyof Dispatcher>](params)
  } catch (e) {
    if (e instanceof ShutdownSignal) throw e
    throw new RpcHandlerError(errorToRpc(e))
  }
}

/** Set the active host before dispatching; restore on the way out. */
export async function withHost<T>(host: HostProvider, fn: () => Promise<T>): Promise<T> {
  return Dispatcher.withHost(host, fn)
}

// (No top-level constants needed here; log buffer caps live in daemon.ts.)
