/**
 * Bun.serve WS bridge between consumer clients and the host provider.
 *
 * Each accepted connection:
 *  1. Validates the WS subprotocol carries the per-daemon secret.
 *  2. Sends a `welcome` event with capabilities + protocol.
 *  3. Spawns a {@link SessionContext} that owns per-ws log coalescing
 *     and subscription tracking.
 *  4. Dispatches RPC requests through `./dispatch.ts`.
 *  5. On `shutdown` RPC: signals the orchestrator (the caller of
 *     {@link startServer}) via the `onShutdown` callback so the daemon
 *     can tear everything down.
 *
 * Per Bun semantics, `websocket.message()` runs sequentially per
 * connection — we serialize RPC handling for free. Concurrent `ws.send`
 * is safe because Bun frames per call.
 */

import type { ServerWebSocket, WebSocketHandler } from 'bun'
import {
  PROTOCOL_VERSION,
  SUBPROTOCOL_PREFIX,
  event,
  ok,
  err,
  tryParseEvent,
  tryParseRequest,
  type RpcError,
  type RpcResponse,
  type WelcomeEvent,
} from './rpc.js'
import { capabilitiesToRecord } from '../../hosts/types.js'
import { RpcHandlerError, ShutdownSignal, dispatch, narrowMethod, withHost, attachLogsCapability, handleSessionClose, type DispatchContext } from './dispatch.js'
import type { ActiveConfig } from './active-config.js'
import { type RebuildState, type WatcherStatus, notification } from './rpc.js'
import { SubscriptionRegistry } from './subscriptions.js'
import type { HostProvider } from '../../hosts/types.js'
import type { SessionContext } from './types.js'

/** Per-connection ws data — the secret is shared across all connections in this daemon. */
interface WsData {
  secret: string
}

/** Max payload for read/write — large enough for a full server jar base64'd. */
const MAX_PAYLOAD = 128 * 1024 * 1024

/** Coalesce log lines across ≤50ms windows; also cap batch size. */
const LOG_FLUSH_MS = 50
const LOG_MAX_BATCH = 64

export interface ServerOptions {
  host: HostProvider
  /** Secret clients must echo in `Sec-WebSocket-Protocol` (after the prefix). */
  secret: string
  /** Bind address. Caller validates reachability (default 127.0.0.1). */
  bind: string
  /** Port to bind. `0` lets the OS pick a free port. */
  port: number
  /** Invoked when the first client sends `shutdown` RPC. */
  onShutdown: () => void | Promise<void>
  /**
   * Live `sandstone.config.ts` state. Seeded by the daemon at boot from
   * disk (`loadActiveConfigFromDisk`) and refreshed whenever the
   * watcher pushes a new snapshot via `publishConfig`. Threaded into
   * every dispatch context so the read-only RPC handlers
   * (`getActiveConfig`, `getBuildOutputTree`, `readBuildLog`) can answer
   * from in-memory state without disk I/O per call.
   *
   * `undefined` only when the daemon was started without a project
   * root (unusual; handlers surface that as `NotConnected`).
   */
  activeConfig?: ActiveConfig
  /**
   * Mutator for the live snapshot. The daemon holds the source of
   * truth and supplies this closure so `publishConfig` can atomically
   * swap the state. Future dispatch contexts pick up the new value
   * via the same closure.
   */
  setActiveConfig?: (cfg: ActiveConfig) => void
  /**
   * Snapshot read of the latest build state the watcher pushed via
   * `publishRebuild`. `undefined` until the first push. Used by MCP
   * `sandstone://rebuild-state` resource handler.
   */
  getRebuildState?: () => RebuildState | undefined
  /** Mutator for the latest build state. */
  setRebuildState?: (state: RebuildState) => void
  /** Snapshot read of the current watcher status. */
  getWatcherStatus?: () => WatcherStatus | null
  /** Mutator for the current watcher status. */
  setWatcherStatus?: (status: WatcherStatus, ws: unknown) => void
  /** Append log entries to one of the daemon's bounded buffers. */
  appendLogLines?: (entries: { line: string; ts: number }[], target: 'build' | 'test') => void
  /** Snapshot read of a named log buffer with filtering. */
  readLogBuffer?: (target: 'build' | 'test', opts?: {
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
}

export interface RunningServer {
  url: string
  port: number
  server: ReturnType<typeof Bun.serve>
  /** Gracefully stop. Returns when all handlers have exited. */
  stop(): Promise<void>
  /**
   * Send a server-pushed event to every open WS session. Also flips
   * each session's `shuttingDown` flag so further RPCs from that client
   * are answered with a synthetic `'daemon shutting down'` error. Used
   * by the daemon during teardown so clients can flush + close cleanly
   * before the WS is killed.
   */
  broadcast(eventName: string, data: unknown): void
}

export function startServer(opts: ServerOptions): RunningServer {
  const subscriptions = new SubscriptionRegistry()
  const startedAt = Date.now()
  // Map (not WeakMap) so we can iterate for `broadcast` — teardown sends
  // a `daemonShutdown` event to every open session before closing the
  // WS so clients can flush state cleanly.
  const sessions = new Map<ServerWebSocket<WsData>, SessionContext>()

  // Hoisted helper used by both the shutdown-RPC path (below) and the
  // returned `RunningServer.broadcast`. Flips each session's
  // `shuttingDown` flag so further RPCs from that client are answered
  // with the synthetic `'daemon shutting down'` error.
  //
  // IMPORTANT: only sets `shuttingDown` when the event is the
  // `daemonShutdown` notification. Other events (`configChanged`,
  // `log`, future `rebuildComplete`) must NOT mark sessions as
  // shutting-down — the watcher sends several RPCs in rapid succession
  // (publishLog, publishConfig, publishWatcherStatus) and any
  // broadcast between them would falsely reject the later ones.
  function broadcast(eventName: string, data: unknown): void {
    const envelope = JSON.stringify(event(eventName, data))
    const isShutdown = eventName === 'daemonShutdown'
    for (const [ws, ctx] of sessions) {
      if (isShutdown) ctx.shuttingDown = true
      try {
        ws.sendText(envelope)
      } catch {
        // Client may have just disconnected; ignore — `close` will
        // clean up its session entry.
      }
    }
  }

  const wsHandler: WebSocketHandler<WsData> = {
    maxPayloadLength: MAX_PAYLOAD,

    open(ws) {
      // Auth was already enforced in the fetch handler (we returned
      // 401 before `srv.upgrade` if the secret didn't match). At this
      // point we trust `ws.data.secret`.
      const ctx: SessionContext = {
        host: opts.host,
        subscriptions: new Set<string>(),
        pendingBySub: new Map(),
        flushTimerBySub: new Map(),
        shuttingDown: false,
      }
      sessions.set(ws, ctx)
      console.log(`[ws] connection opened (${ws.remoteAddress})`)

      const welcomeCaps = capabilitiesToRecord(opts.host.capabilities)
      // Same gating as the `ping` RPC handler — clients pick
      // attachLog vs attachLogs based on this welcome.
      if (attachLogsCapability(opts.host)) {
        welcomeCaps.attachLogs = true
      }
      const welcome: WelcomeEvent = {
        protocol: PROTOCOL_VERSION,
        hostType: opts.host.type,
        displayName: opts.host.displayName,
        capabilities: welcomeCaps,
        pid: process.pid,
        startedAt: new Date(startedAt).toISOString(),
      }
      ws.sendText(JSON.stringify(event('welcome', welcome)))
    },

    async message(ws, raw) {
      const ctx = sessions.get(ws)
      if (!ctx) {
        ws.close(1011, 'no session')
        return
      }
      if (ctx.shuttingDown) {
        // After daemonShutdown was sent, ignore further RPCs. Reply with
        // a synthetic error so the client doesn't hang waiting on a
        // request that will never resolve.
        const parsed = tryParseRequest(raw)
        if (parsed && 'method' in parsed && 'id' in parsed) {
          ws.sendText(
            JSON.stringify({
              id: parsed.id,
              error: { code: -32006, message: 'daemon shutting down' },
            } satisfies RpcResponse),
          )
        }
        return
      }

      const parsed = tryParseRequest(raw)
      if (!parsed) {
        if (tryParseEvent(raw)) return
        return
      }
      if ('code' in parsed) {
        // It's a parse-failure response from the codec — has no `id`
        // for the malformed payload, so we just close.
        const rpcErr = parsed as RpcError
        if ('id' in rpcErr && typeof (rpcErr as { id?: unknown }).id !== 'undefined') {
          ws.sendText(JSON.stringify(err((rpcErr as { id: string | number }).id, rpcErr)))
        } else {
          ws.close(1003, rpcErr.message)
        }
        return
      }

      const dispatchCtx: DispatchContext = {
        host: opts.host,
        subscriptions,
        ws,
        pushLog: (lines, subscriptionId, hostType) => pushLog(ctx, ws, subscriptionId, lines, hostType),
        startedAt,
        activeConfig: opts.activeConfig,
        setActiveConfig: opts.setActiveConfig,
        getRebuildState: opts.getRebuildState,
        setRebuildState: opts.setRebuildState,
        getWatcherStatus: opts.getWatcherStatus,
        setWatcherStatus: opts.setWatcherStatus,
        appendLogLines: opts.appendLogLines,
        readLogBuffer: opts.readLogBuffer,
        broadcast,
        notifyResourceUpdated: (uri) => {
          console.error(`[notify-debug] notifyResourceUpdated(${uri}) sessions=${sessions.size}`)
          // Fire `notifications/resources/updated` to every connected
          // session. Uses the JSON-RPC notification envelope (not the
          // legacy `{event, data}` shape that `broadcast` uses for
          // custom events). Clients without a subscription for `uri`
          // ignore the notification per spec.
          const envelope = JSON.stringify(notification(
            'notifications/resources/updated',
            { uri },
          ))
          for (const [ws, ctx] of sessions) {
            console.error(`[notify-debug]   sending to ws shuttingDown=${ctx.shuttingDown}`)
            try { ws.sendText(envelope) } catch { /* disconnected */ }
          }
        },
      }

      // Narrow the wire-string method to RpcMethod so `dispatch<M>` is
      // typesafe end-to-end. Unknown methods throw here (caught below
      // and treated as fatal).
      const typedMethod = narrowMethod(parsed.method)

      const startMs = Date.now()
      console.error(
        `[ws] ← ${parsed.method} id=${parsed.id}${parsed.params !== undefined ? ` params=${JSON.stringify(parsed.params)}` : ''}`,
      )

      let response: RpcResponse
      try {
        const result = await withHost(opts.host, () =>
          dispatch(dispatchCtx, { ...parsed, method: typedMethod }),
        )
        response = ok(parsed.id, result)
        response = ok(parsed.id, result)
      } catch (e) {
        if (e instanceof ShutdownSignal) {
          // Reply OK to the requester, then broadcast the shutdown
          // event to every session (including this one) so all clients
          // get a chance to flush + close cleanly.
          ws.sendText(JSON.stringify(ok(parsed.id, null)))
          for (const subId of ctx.pendingBySub.keys()) flushLogs(ctx, ws, subId)
          broadcast('daemonShutdown', { reason: 'shutdown-rpc' })
          console.error(`[ws] → ${parsed.method} id=${parsed.id} shutdown-rpc (${Date.now() - startMs}ms)`)
          queueMicrotask(() => {
            void opts.onShutdown()
          })
          return
        }
        // Handler error (RpcHandlerError) or unknown throw — fatal.
        // Preserve the handler's typed RpcError if present, otherwise
        // coerce to InternalError. Send the err, then shut the daemon
        // down so the failure isn't masked by a transient-looking
        // response.
        const rpcErr = e instanceof RpcHandlerError ? e.rpc : {
          code: -32603,
          message: e instanceof Error ? e.message : String(e),
        }
        response = err(parsed.id, rpcErr)
        ws.sendText(JSON.stringify(response))
        const status = `err:${rpcErr.code}`
        console.error(
          `[ws] → ${parsed.method} id=${parsed.id} ${status} ${rpcErr.message} (${Date.now() - startMs}ms) — shutting down`,
        )
        queueMicrotask(() => {
          void opts.onShutdown()
        })
        return
      }
      ws.sendText(JSON.stringify(response))
      const status = 'ok'
      console.error(
        `[ws] → ${parsed.method} id=${parsed.id} ${status} result=${JSON.stringify(response.result)} (${Date.now() - startMs}ms)`,
      )
    },

    async close(ws) {
      const ctx = sessions.get(ws)
      if (!ctx) return
      sessions.delete(ws)
      for (const timer of ctx.flushTimerBySub.values()) clearTimeout(timer)
      ctx.flushTimerBySub.clear()
      await subscriptions.dropAllForWs(ws)
      // Daemon-supplied hook — used to detect watcher disconnects and
      // flip `connected: false` on the cached `WatcherStatus`.
      // Build a minimal dispatchCtx with only the hooks
      // `handleSessionClose` needs. The full ctx isn't available here
      // because session close happens outside any request.
      handleSessionClose(ws, {
        setWatcherStatus: opts.setWatcherStatus,
        getWatcherStatus: opts.getWatcherStatus,
        notifyResourceUpdated: (uri: string) => {
          const envelope = JSON.stringify(notification(
            'notifications/resources/updated',
            { uri },
          ))
          for (const [session] of sessions) {
            try { session.sendText(envelope) } catch { /* disconnected */ }
          }
        },
      } as unknown as DispatchContext)
      console.log(`[ws] connection closed (${ws.remoteAddress})`)
    },
  }

  const server = Bun.serve<WsData>({
    hostname: opts.bind,
    port: opts.port,
    websocket: wsHandler,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/health') {
        return new Response('ok')
      }
      const protoHeader = req.headers.get('sec-websocket-protocol')
      if (!protoHeader) {
        return new Response('missing subprotocol', { status: 400 })
      }
      const candidates = protoHeader.split(',').map((s) => s.trim())
      const expected = SUBPROTOCOL_PREFIX + opts.secret
      if (!candidates.includes(expected)) {
        return new Response('bad subprotocol', { status: 401 })
      }
      const upgraded = srv.upgrade(req, {
        data: { secret: opts.secret },
        headers: { 'Sec-WebSocket-Protocol': expected },
      })
      if (upgraded) return undefined
      return new Response('upgrade failed', { status: 500 })
    },
  })

  // Bun resolves `port: 0` to a free port and exposes it on
  // `server.port`. When the user passes an explicit port the value is
  // the same. `number | undefined` covers the rare case where Bun
  // hasn't bound yet — treat as failure.
  const boundPort = server.port
  if (typeof boundPort !== 'number') {
    throw new Error('Bun.serve did not bind a port')
  }
  const url = `ws://${opts.bind}:${boundPort}`

  return {
    url,
    port: boundPort,
    server,
    async stop() {
      await server.stop()
    },
    broadcast,
  }
}

// ---------------------------------------------------------------------------
// Log coalescing
// ---------------------------------------------------------------------------

function pushLog(ctx: SessionContext, ws: ServerWebSocket<WsData>, subscriptionId: string, lines: string[], hostType?: string): void {
  // Fan-out batches carry a hostType so the client can attribute lines to
  // their emitting member. Send them immediately without coalescing —
  // batching multiple hostType-tagged batches would lose attribution
  // if a second member pushes before the timer fires. Single-host
  // batches (no hostType) keep the original coalescing for bandwidth.
  if (hostType !== undefined) {
    ws.sendText(JSON.stringify(event('log', { subscriptionId, lines, hostType })))
    return
  }
  let pending = ctx.pendingBySub.get(subscriptionId)
  if (!pending) {
    pending = []
    ctx.pendingBySub.set(subscriptionId, pending)
  }
  pending.push(...lines)
  if (pending.length > LOG_MAX_BATCH * 4) {
    pending.splice(0, pending.length - LOG_MAX_BATCH * 4)
  }
  if (ctx.flushTimerBySub.has(subscriptionId)) return
  ctx.flushTimerBySub.set(subscriptionId, setTimeout(() => {
    ctx.flushTimerBySub.delete(subscriptionId)
    flushLogs(ctx, ws, subscriptionId)
  }, LOG_FLUSH_MS))
}

function flushLogs(ctx: SessionContext, ws: ServerWebSocket<WsData>, subscriptionId: string): void {
  const pending = ctx.pendingBySub.get(subscriptionId)
  if (!pending || pending.length === 0) return
  const batch = pending.splice(0, LOG_MAX_BATCH)
  ws.sendText(JSON.stringify(event('log', { subscriptionId, lines: batch })))
  if (pending.length > 0) {
    ctx.flushTimerBySub.set(subscriptionId, setTimeout(() => {
      ctx.flushTimerBySub.delete(subscriptionId)
      flushLogs(ctx, ws, subscriptionId)
    }, LOG_FLUSH_MS))
  } else {
    ctx.pendingBySub.delete(subscriptionId)
  }
}