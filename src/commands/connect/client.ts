/**
 * Minimal WebSocket client for the `sand connect` daemon.
 *
 * Used in v1 by `sand connect --shutdown` (a one-shot RPC). The shape
 * is generic enough that future consumer commands (deploy, console
 * tail, etc.) can reuse it.
 *
 * Bun's global `WebSocket` is used as the client — no extra dep.
 */

import {
  SUBPROTOCOL_PREFIX,
  err,
  ok,
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
  type GetWatcherStatusResult,
  type ReadTestLogResult,
  type ReadFileResult,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
  type TriggerBuildEvent,
  type WelcomeEvent,
} from './rpc.js'
import type { ActiveSaveConfig } from '../../utils/activeSaveConfig.js'
import type { EndpointFile } from './endpoint-file.js'

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

/**
 * Open a WebSocket to the daemon and resolve once the `welcome` event
 * arrives. The returned client exposes typed RPC helpers + an
 * `onLog` subscription callback.
 */
export async function connect(opts: ClientOptions): Promise<Client> {
  const ws = new WebSocket(opts.endpoint.url, [SUBPROTOCOL_PREFIX + opts.endpoint.secret])
  const timeoutMs = opts.requestTimeoutMs ?? 30_000

  const welcome = await new Promise<WelcomeEvent>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('welcome timed out')), timeoutMs)
    ws.addEventListener('open', () => {
      // wait for first message
    })
    ws.addEventListener('error', (e) => {
      clearTimeout(t)
      reject(new Error(`ws error: ${e}`))
    })
    ws.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
      const parsed = JSON.parse(data) as { event?: string; data?: unknown }
      if (parsed.event === 'welcome') {
        clearTimeout(t)
        resolve(parsed.data as WelcomeEvent)
      }
    })
  })

  const pending = new Map<string | number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  // Per-subscriptionId listener set. Each `attachLog` call produces a
  // LogSubscription whose `onLines` registers here; the websocket log
  // event dispatches by subscriptionId.
  type InternalListener = (lines: string[]) => void
  const listenersBySub = new Map<string, Set<InternalListener>>()
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
  const triggerBuildHandlers = new Set<(event: TriggerBuildEvent) => void>()
  // Catch-all fallback for WS-received notifications that don't match
  // any typed handler. Used by MCP to bridge daemon pushes
  // (e.g. `notifications/resources/updated`) to the stdio transport.
  let fallbackNotificationHandler: ((notif: { method: string; params?: unknown }) => Promise<void> | void) | undefined
  let nextId = 1
  let closed = false

  ws.addEventListener('message', (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
    const parsed = JSON.parse(data) as RpcResponse | { event?: string; data?: unknown; method?: string; params?: unknown }
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
      for (const h of triggerBuildHandlers) {
        try { h(parsed.data as TriggerBuildEvent) } catch { /* swallow */ }
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
      ws.send(JSON.stringify(req))
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

  return {
    welcome,
    ping: () => call<PingResult>('ping'),
    startServer: () => call<void>('startServer'),
    stopServer: (params) => call<void>('stopServer', params),
    readFile: (params) => call<ReadFileResult>('readFile', params),
    writeFile: (params) => call<void>('writeFile', params),
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
    onTriggerBuild(handler: (event: TriggerBuildEvent) => void): () => void {
      triggerBuildHandlers.add(handler)
      return () => {
        triggerBuildHandlers.delete(handler)
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
  readFile(params: { path: string }): Promise<ReadFileResult>
  writeFile(params: { path: string; data: string; encoding?: 'utf-8' | 'base64' }): Promise<void>
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

// Unused-but-imported helpers — keep them reachable so future helpers
// can reuse the same imports.
void ok
void err

function rpcErrorToException(e: RpcError): Error {
  const msg = `[rpc ${e.code}] ${e.message}`
  const err = new Error(msg)
  ;(err as Error & { code: number }).code = e.code
  return err
}