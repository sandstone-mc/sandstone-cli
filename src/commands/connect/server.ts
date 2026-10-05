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
 */

import type { ServerWebSocket, WebSocketHandler } from 'bun'
import {
  PROTOCOL_VERSION,
  SUBPROTOCOL_PREFIX,
  event,
  ok,
  err,
  classifyWsMessage,
  type RpcMethod,
  type RpcResponse,
  type WelcomeEvent,
} from './rpc.js'
import { capabilitiesToRecord } from '../../hosts/types.js'
import { RpcHandlerError, ShutdownSignal, Dispatcher, dispatch, narrowMethod, type DispatcherContext } from './dispatch.js'
import type { ActiveConfig } from './active-config.js'
import type { RebuildState, TestState, WatcherStatus, RpcEventName, RpcEventMap, LogLineEntry } from './rpc.js'
import { notification } from './rpc.js'
import { SubscriptionRegistry, WaitLogSubscriptionRegistry } from './subscriptions.js'
import { LogMatcher } from './wait-log.js'
import { StreamRegistry } from './streams.js'
import { encodeRpc, decodeStreamChunk, streamIdHex, STREAM_MAGIC } from './codec.js'
import type { HostProvider } from '../../hosts/types.js'
import type { SandstoneConfig } from 'sandstone'

export interface WsData {
  secret: string
}

export interface SessionContext {
  host: HostProvider
  subscriptions: Set<string>
  pendingBySub: Map<string, LogLineEntry[]>
  flushTimerBySub: Map<string, ReturnType<typeof setTimeout>>
  shuttingDown: boolean
  dispatcher: Dispatcher
}

/** Max WS payload size. */
const MAX_PAYLOAD = 128 * 1024 * 1024

const LOG_FLUSH_MS = 50
const LOG_MAX_BATCH = 64

export interface ServerOptions {
  host: HostProvider
  secret: string
  /** Bind address. Caller validates reachability (default 127.0.0.1). */
  bind: string
  /** Port to bind. `0` lets the OS pick a free port. */
  port: number
  onShutdown: () => Promise<void>
  onWsClose?: (ws: ServerWebSocket<WsData>) => void
  getActiveConfig?: () => ActiveConfig | undefined
  setActiveConfig?: (cfg: ActiveConfig) => void
  getRebuildState?: () => RebuildState | undefined
  setRebuildState?: (state: RebuildState) => void
  getTestState?: () => TestState | undefined
  setTestState?: (state: TestState) => void
  getWatcherStatus?: () => WatcherStatus | null
  setWatcherStatus?: (status: WatcherStatus, ws: Bun.ServerWebSocket<WsData> | undefined) => void
  getExpectedShutdown?: () => boolean
  getFullConfig?: () => SandstoneConfig | undefined
  appendLogLines?: (entries: LogLineEntry[], target: 'build' | 'test' | 'server') => void
  readLogBuffer?: (target: 'build' | 'test' | 'server', opts?: {
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
  stop(): Promise<void>
  broadcast<K extends RpcEventName>(eventName: K, data: RpcEventMap[K]): void
  notifyResourceUpdated(uri: string): void
}

export function startServer(opts: ServerOptions): RunningServer {
  const subscriptions = new SubscriptionRegistry()
  const waitLogSubs = new WaitLogSubscriptionRegistry()
  const streams = new StreamRegistry()
  const startedAt = Date.now()
  const sessions = new Map<ServerWebSocket<WsData>, SessionContext>()
  const logMatcher = opts.host.attachLog ? new LogMatcher(opts.host.attachLog.bind(opts.host)) : null

  const notifyAll = (uri: string) => {
    const envelope = encodeRpc(notification('notifications/resources/updated', { uri }))
    for (const [session] of sessions) {
      try { session.send(envelope) } catch { /* disconnected */ }
    }
  }

  function broadcast<K extends RpcEventName>(eventName: K, data: RpcEventMap[K]): void {
    const envelope = encodeRpc(event(eventName, data))
    const isShutdown = eventName === 'daemonShutdown'
    for (const [ws, ctx] of sessions) {
      if (isShutdown) ctx.shuttingDown = true
      try {
        ws.send(envelope)
      } catch {}
    }
  }

  const wsHandler: WebSocketHandler<WsData> = {
    maxPayloadLength: MAX_PAYLOAD,

    open(ws) {
      const ctx: SessionContext = {
        host: opts.host,
        subscriptions: new Set<string>(),
        pendingBySub: new Map(),
        flushTimerBySub: new Map(),
        shuttingDown: false,
        dispatcher: undefined as unknown as Dispatcher, // assigned below
      }
      const dispatchCtx: DispatcherContext = {
        host: opts.host,
        subscriptions,
        waitLogSubscriptions: waitLogSubs,
        logMatcher: logMatcher ?? new LogMatcher(async () => { throw new Error('Host does not support attachLog') }),
        ws,
        streams,
        pushLog: (lines, subscriptionId) => pushLog(ctx, ws, subscriptionId, lines),
        startedAt,
        getActiveConfig: () => opts.getActiveConfig?.(),
        setActiveConfig: opts.setActiveConfig,
        getRebuildState: opts.getRebuildState,
        setRebuildState: opts.setRebuildState,
        getExpectedShutdown: opts.getExpectedShutdown,
        getFullConfig: opts.getFullConfig,
        getWatcherStatus: opts.getWatcherStatus,
        setWatcherStatus: opts.setWatcherStatus,
        appendLogLines: opts.appendLogLines,
        readLogBuffer: opts.readLogBuffer,
        broadcast,
        notifyResourceUpdated: notifyAll,
      }
      ctx.dispatcher = new Dispatcher(dispatchCtx)
      sessions.set(ws, ctx)
      console.log(`[ws] connection opened (${ws.remoteAddress})`)

      const welcomeCaps = capabilitiesToRecord(opts.host.capabilities)
      const welcome: WelcomeEvent = {
        protocol: PROTOCOL_VERSION,
        hostType: opts.host.type,
        displayName: opts.host.displayName,
        capabilities: welcomeCaps,
        pid: process.pid,
        startedAt: new Date(startedAt).toISOString(),
      }
      ws.send(encodeRpc(event('welcome', welcome)))
    },

    async message(ws, raw) {
      const ctx = sessions.get(ws)
      if (!ctx) {
        ws.close(1011, 'no session')
        return
      }
      if (typeof raw !== 'string' && raw.byteLength >= 17 && raw[0] === STREAM_MAGIC) {
        const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
        const { streamId, chunk } = decodeStreamChunk(buf)
        const candidateKey = streamIdHex(streamId)
        const stream = streams.get(candidateKey)
        if (stream && stream.kind === 'writeFile') {
          stream.bytes += chunk.byteLength
          const writer = streams.writer(candidateKey)
          if (writer) {
            writer.write(chunk).catch((err: unknown) => {
              streams.close(candidateKey, stream.bytes, err instanceof Error ? err : new Error(String(err)))
            })
          }
          return
        }
      }

      if (ctx.shuttingDown) {
        const msg = classifyWsMessage(raw)
        if (msg && msg.kind === 'request') {
          ws.send(encodeRpc({
            id: msg.id,
            error: { code: -32006, message: 'daemon shutting down' },
          } satisfies RpcResponse))
        }
        return
      }

      const msg = classifyWsMessage(raw)
      if (!msg) return
      if (msg.kind === 'event') return

      if (msg.kind === 'notification') {
        const notifStart = Date.now()
        let notifMethod: RpcMethod
        try {
          notifMethod = narrowMethod(msg.method)
        } catch (e) {
          const rpcErr = e instanceof RpcHandlerError ? e.rpc : {
            code: -32603,
            message: e instanceof Error ? e.message : String(e),
          }
          console.error(`[ws] ← notification ${msg.method} → err:${rpcErr.code} ${rpcErr.message} (${Date.now() - notifStart}ms) — unknown notification method`)
          return
        }
        console.error(`[ws] ← notification ${notifMethod} params=${JSON.stringify(msg.params)}`)
        try {
          await dispatch(ctx.dispatcher, notifMethod, msg.params as never)
          console.error(`[ws] → notification ${notifMethod} ok (${Date.now() - notifStart}ms)`)
        } catch (e) {
          if (e instanceof ShutdownSignal) {
            broadcast('daemonShutdown', { reason: 'shutdown-rpc' })
            console.error(`[ws] → notification ${notifMethod} shutdown-rpc (${Date.now() - notifStart}ms)`)
            queueMicrotask(() => {
              opts.onShutdown().catch(() => {})
            })
            return
          }
          const rpcErr = e instanceof RpcHandlerError ? e.rpc : {
            code: -32603,
            message: e instanceof Error ? e.message : String(e),
          }
          console.error(`[ws] → notification ${notifMethod} err:${rpcErr.code} ${rpcErr.message} (${Date.now() - notifStart}ms)`)
        }
        return
      }

      if (msg.kind !== 'request') return
      const parsed = msg

      const typedMethod = narrowMethod(parsed.method)

      const startMs = Date.now()
      console.error(
        `[ws] ← ${parsed.method} id=${parsed.id}${parsed.params !== undefined ? ` params=${JSON.stringify(parsed.params)}` : ''}`,
      )

      let response: RpcResponse
      try {
        const result = await dispatch(ctx.dispatcher, typedMethod, parsed.params as never)
        response = ok(parsed.id, result)
      } catch (e) {
        if (e instanceof ShutdownSignal) {
          ws.send(encodeRpc(ok(parsed.id, null)))
          for (const subId of ctx.pendingBySub.keys()) flushLogs(ctx, ws, subId)
          broadcast('daemonShutdown', { reason: 'shutdown-rpc' })
          console.error(`[ws] → ${parsed.method} id=${parsed.id} shutdown-rpc (${Date.now() - startMs}ms)`)
          queueMicrotask(() => {
            opts.onShutdown().catch(() => {})
          })
          return
        }
        const rpcErr = e instanceof RpcHandlerError ? e.rpc : {
          code: -32603,
          message: e instanceof Error ? e.message : String(e),
        }
        response = err(parsed.id, rpcErr)
        ws.send(encodeRpc(response))
        const status = `err:${rpcErr.code}`
        if (opts.getExpectedShutdown?.()) {
          console.error(
            `[ws] → ${parsed.method} id=${parsed.id} ${status} ${rpcErr.message} (${Date.now() - startMs}ms) — expected shutdown cycle, daemon stays up`,
          )
          return
        }
        console.error(
          `[ws] → ${parsed.method} id=${parsed.id} ${status} ${rpcErr.message} (${Date.now() - startMs}ms) — shutting down`,
        )
        queueMicrotask(() => {
          opts.onShutdown().catch(() => {})
        })
        return
      }
      ws.send(encodeRpc(response))
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
      await waitLogSubs.dropAllForWs(ws)
      // Detects watcher disconnects and flips `connected: false` on the cached `WatcherStatus`.
      opts.onWsClose?.(ws)
      streams.closeAll(new Error('ws session closed'))
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
    notifyResourceUpdated: notifyAll,
  }
}

function pushLog(ctx: SessionContext, ws: ServerWebSocket<WsData>, subscriptionId: string, lines: LogLineEntry[]): void {
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
  ws.send(encodeRpc(event('log', { subscriptionId, lines: batch })))
  if (pending.length > 0) {
    ctx.flushTimerBySub.set(subscriptionId, setTimeout(() => {
      ctx.flushTimerBySub.delete(subscriptionId)
      flushLogs(ctx, ws, subscriptionId)
    }, LOG_FLUSH_MS))
  } else {
    ctx.pendingBySub.delete(subscriptionId)
  }
}