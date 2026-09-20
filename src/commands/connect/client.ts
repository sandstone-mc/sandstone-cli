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
  type PingResult,
  type ReadFileResult,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
  type WelcomeEvent,
} from './rpc.js'
import type { EndpointFile } from './endpoint-file.js'

/**
 * Handle returned by `attachLog`. Each call to `onLines` registers a
 * listener for lines from this subscription only; `hostType` is never
 * surfaced because the underlying RPC (`attachLog`) only routes to one
 * member.
 */
export interface AttachLogSubscription {
  readonly subscriptionId: string
  /** Register a listener for line batches from this subscription. Lines
   *  are passed through verbatim — no hostType. */
  onLines(fn: (lines: string[]) => void): void
  /** Release the server-side subscription. Safe to call multiple times. */
  unattach(): Promise<void>
}

/**
 * Handle returned by `attachLogs`. The fan-out variant tags every batch
 * with the emitting member's host type so callers can label output.
 * Only available when the daemon advertises the `attachLogs`
 * capability.
 */
export interface AttachLogsSubscription {
  readonly subscriptionId: string
  /** Register a listener for line batches from this subscription. Each
   *  batch carries the host type of its emitting composite member. */
  onLines(fn: (lines: string[], hostType: string) => void): void
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
  // Per-subscriptionId listener set. Each `attachLog` / `attachLogs` call
  // produces a LogSubscription whose `onLines` registers here; the
  // websocket log event dispatches by subscriptionId so a hostType-aware
  // fan-out subscription never leaks its tag onto a single-host listener.
  type InternalListener = (lines: string[], hostType: string | undefined) => void
  const listenersBySub = new Map<string, Set<InternalListener>>()
  // Shutdown listeners registered via `Client.onShutdown`. Fired once
  // when the daemon broadcasts `daemonShutdown`, then cleared. Each
  // call returns an unsubscribe closure so callers can detach.
  const shutdownHandlers = new Set<(reason: string) => void>()
  let nextId = 1
  let closed = false

  ws.addEventListener('message', (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
    const parsed = JSON.parse(data) as RpcResponse | { event: string; data: unknown }
    if ('event' in parsed && parsed.event === 'log') {
      const logData = parsed.data as { subscriptionId: string; lines: string[]; hostType?: string }
      const subs = listenersBySub.get(logData.subscriptionId)
      if (!subs) return
      for (const fn of subs) fn(logData.lines, logData.hostType)
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

  function buildFanout(subscriptionId: string): AttachLogsSubscription {
    let detached = false
    const set = new Set<InternalListener>()
    listenersBySub.set(subscriptionId, set)
    return {
      subscriptionId,
      onLines(fn: (lines: string[], hostType: string) => void) {
        // Every fan-out batch carries a hostType. If the server ever
        // omits it (legacy single-host fallback path), label with
        // 'unknown' to keep the public contract — listeners can always
        // trust the second arg.
        set.add((lines, hostType) => fn(lines, hostType ?? 'unknown'))
      },
      async unattach() {
        if (detached) return
        detached = true
        listenersBySub.delete(subscriptionId)
        try {
          await call<void>('unattach', { subscriptionId })
        } catch {
          // Daemon may already be gone; cascade-clean will fire.
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
    async attachLogs(params) {
      const res = await call<{ subscriptionId: string }>('attachLogs', params)
      return buildFanout(res.subscriptionId)
    },
    shutdown: () => call<void>('shutdown'),
    onShutdown(handler: (reason: string) => void): () => void {
      shutdownHandlers.add(handler)
      return () => {
        shutdownHandlers.delete(handler)
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
  /** Subscribe to a single host's log stream. */
  attachLog(params?: { regex?: string }): Promise<AttachLogSubscription>
  /** Subscribe to a fan-out of every attachLog-capable member of a
   *  composite daemon. Only available when the daemon advertises the
   *  `attachLogs` capability. */
  attachLogs(params?: { regex?: string }): Promise<AttachLogsSubscription>
  shutdown(): Promise<void>
  /**
   * Register a one-shot listener for the daemon's `daemonShutdown`
   * event. The handler fires once when the daemon begins teardown
   * (any reason — signal, EOF, `--shutdown` RPC, host member
   * disconnected). Returns an unsubscribe function. Listeners are
   * auto-cleared after firing.
   */
  onShutdown(handler: (reason: string) => void): () => void
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