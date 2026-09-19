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
import { RpcHandlerError, ShutdownSignal, dispatch, narrowMethod, withHost, type DispatchContext } from './dispatch.js'
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
}

export interface RunningServer {
  url: string
  port: number
  server: ReturnType<typeof Bun.serve>
  /** Gracefully stop. Returns when all handlers have exited. */
  stop(): Promise<void>
}

export function startServer(opts: ServerOptions): RunningServer {
  const subscriptions = new SubscriptionRegistry()
  const startedAt = Date.now()
  const sessions = new WeakMap<ServerWebSocket<WsData>, SessionContext>()

  const wsHandler: WebSocketHandler<WsData> = {
    maxPayloadLength: MAX_PAYLOAD,

    open(ws) {
      // Auth was already enforced in the fetch handler (we returned
      // 401 before `srv.upgrade` if the secret didn't match). At this
      // point we trust `ws.data.secret`.
      const ctx: SessionContext = {
        host: opts.host,
        subscriptions: new Set<string>(),
        pendingLines: [],
        flushTimer: null,
        shuttingDown: false,
      }
      sessions.set(ws, ctx)

      const welcome: WelcomeEvent = {
        protocol: PROTOCOL_VERSION,
        hostType: opts.host.type,
        displayName: opts.host.displayName,
        capabilities: capabilitiesToRecord(opts.host.capabilities),
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
        pushLog: (lines) => pushLog(ctx, ws, lines),
        startedAt,
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
          ctx.shuttingDown = true
          ws.sendText(JSON.stringify(ok(parsed.id, null)))
          ws.sendText(JSON.stringify(event('daemonShutdown', { reason: 'shutdown-rpc' })))
          flushLogs(ctx, ws)
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
      if (ctx.flushTimer) {
        clearTimeout(ctx.flushTimer)
        ctx.flushTimer = null
      }
      await subscriptions.dropAllForWs(ws)
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
  }
}

// ---------------------------------------------------------------------------
// Log coalescing
// ---------------------------------------------------------------------------

function pushLog(ctx: SessionContext, ws: ServerWebSocket<WsData>, lines: string[]): void {
  ctx.pendingLines.push(...lines)
  if (ctx.pendingLines.length > LOG_MAX_BATCH * 4) {
    ctx.pendingLines.splice(0, ctx.pendingLines.length - LOG_MAX_BATCH * 4)
  }
  if (ctx.flushTimer) return
  ctx.flushTimer = setTimeout(() => {
    ctx.flushTimer = null
    flushLogs(ctx, ws)
  }, LOG_FLUSH_MS)
}

function flushLogs(ctx: SessionContext, ws: ServerWebSocket<WsData>): void {
  if (ctx.pendingLines.length === 0) return
  const batch = ctx.pendingLines.splice(0, LOG_MAX_BATCH)
  ws.sendText(JSON.stringify(event('log', { lines: batch })))
  if (ctx.pendingLines.length > 0) {
    ctx.flushTimer = setTimeout(() => {
      ctx.flushTimer = null
      flushLogs(ctx, ws)
    }, LOG_FLUSH_MS)
  }
}