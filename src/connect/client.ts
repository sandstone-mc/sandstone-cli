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
  type AttachLogResult,
  type ExecuteRawCommandResult,
  type PingResult,
  type ReadFileResult,
  type RpcError,
  type RpcRequest,
  type RpcResponse,
  type WelcomeEvent,
} from './rpc.js'
import type { EndpointFile } from './endpoint-file.js'

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
  const logListeners = new Set<(subscriptionId: string, lines: string[]) => void>()
  let nextId = 1
  let closed = false

  ws.addEventListener('message', (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
    const parsed = JSON.parse(data) as RpcResponse | { event: string; data: unknown }
    if ('event' in parsed && parsed.event === 'log') {
      const data = parsed.data as { subscriptionId: string; lines: string[] }
      for (const fn of logListeners) fn(data.subscriptionId, data.lines)
      return
    }
    if ('event' in parsed && parsed.event === 'daemonShutdown') {
      closed = true
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer)
        reject(new Error('daemon shutting down'))
      }
      pending.clear()
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
    const req: RpcRequest = { id, method, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`rpc '${method}' timed out`))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer })
      ws.send(JSON.stringify(req))
    })
  }

  return {
    welcome,
    ping: () => call<PingResult>('ping'),
    startServer: () => call<void>('startServer'),
    stopServer: (params) => call<void>('stopServer', params),
    readFile: (params) => call<ReadFileResult>('readFile', params),
    writeFile: (params) => call<void>('writeFile', params),
    executeRawCommand: (params) => call<ExecuteRawCommandResult>('executeRawCommand', params),
    attachLog: (params) => call<AttachLogResult>('attachLog', params),
    unattach: (params) => call<void>('unattach', params),
    shutdown: () => call<void>('shutdown'),
    onLog(fn) {
      logListeners.add(fn)
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
  attachLog(params?: { regex?: string }): Promise<AttachLogResult>
  unattach(params: { subscriptionId: string }): Promise<void>
  shutdown(): Promise<void>
  onLog(fn: (subscriptionId: string, lines: string[]) => void): void
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