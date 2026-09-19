/**
 * Wire protocol for the `sand connect` daemon.
 *
 * JSON-over-WebSocket envelopes with a discriminator on shape:
 *  - Client → server: `{ id, method, params? }` → `{ id, result? | error? }`
 *  - Server → client: `{ event, data }` (no `id`)
 *
 * JSON-RPC-style error codes for the standard cases, plus a -32xxx range
 * for host-specific errors. The mapping from host error classes lives in
 * {@link errorToRpc}.
 */

import { HostAuthError, NotConnectedError, UnsupportedCapabilityError } from '../hosts/errors.js'

/** Bump when the on-wire shape changes incompatibly. */
export const PROTOCOL_VERSION = 1

/**
 * WS subprotocol prefix. Server validates the value after the dot matches
 * the per-daemon `secret` from the endpoint file — clients must read the
 * file or be passed the secret another way.
 */
export const SUBPROTOCOL_PREFIX = 'sandstone-connect-v1.'

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * Client → server request. `id` can be any JSON-serializable scalar the
 * client chooses; the server echoes it back. `params` is method-specific.
 *
 * `method` is typed as the union {@link RpcMethod}; the server narrows
 * wire-string methods to this type via {@link narrowMethod} before
 * dispatching. The generic `M` parameter lets `dispatch<M>` propagate
 * concrete result types from {@link RpcMethodResult}.
 */
export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  id: string | number
  method: M
  params?: unknown
}

/** Every RPC method the daemon understands. */
export type RpcMethod =
  | 'ping'
  | 'startServer'
  | 'stopServer'
  | 'readFile'
  | 'writeFile'
  | 'executeRawCommand'
  | 'attachLog'
  | 'unattach'
  | 'shutdown'

/**
 * Union of every possible RPC handler return type. `dispatch` and
 * `route` both return this; the server wraps the value in an
 * `RpcResponse` envelope regardless of which member it is.
 */
export type RpcResult =
  | PingResult
  | ReadFileResult
  | ExecuteRawCommandResult
  | AttachLogResult
  | void

/**
 * Server → client response. Exactly one of `result` / `error` is set.
 */
export interface RpcResponse {
  id: string | number
  result?: unknown
  error?: RpcError
}

/** Server-pushed event. Discriminator is the `event` field. */
export interface RpcEvent {
  event: string
  data: unknown
}

/** JSON-RPC-style error object. `code` is one of {@link RpcErrorCode}. */
export interface RpcError {
  code: number
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Sent once immediately after WS upgrade. */
export interface WelcomeEvent {
  protocol: typeof PROTOCOL_VERSION
  hostType: string
  displayName: string
  capabilities: Record<string, boolean>
  pid: number
  startedAt: string
}

/** Pushed when a subscribed log session emits lines. */
export interface LogEvent {
  subscriptionId: string
  lines: string[]
}

/** Pushed when the host's connection state transitions. */
export interface HostStateEvent {
  state: 'connected' | 'disconnected' | 'lost'
  reason?: string
}

/** Final message sent before the WS closes during shutdown. */
export interface DaemonShutdownEvent {
  reason: 'signal' | 'shutdown-rpc' | 'host-lost'
}

// ---------------------------------------------------------------------------
// Methods (params + results)
// ---------------------------------------------------------------------------

export interface StopServerParams {
  timeoutSeconds?: number
}

export interface ReadFileParams {
  path: string
}
export interface ReadFileResult {
  /** base64-encoded file contents */
  data: string
  size: number
}

export interface WriteFileParams {
  path: string
  /**
   * File contents. Always base64 unless `encoding: 'utf-8'` is set, in
   * which case it's a UTF-8 string.
   */
  data: string
  encoding?: 'utf-8' | 'base64'
}

export interface ExecuteRawCommandParams {
  command: string
}
export interface ExecuteRawCommandResult {
  /** Best-effort; providers may return '' if response capture is unreliable. */
  output: string
}

export interface AttachLogParams {
  /** Optional filter regex — only matching lines are forwarded. */
  regex?: string
}
export interface AttachLogResult {
  subscriptionId: string
  /** Lines buffered since host connect, if the host exposes one. */
  replay?: string[]
}

export interface UnattachParams {
  subscriptionId: string
}

export interface PingResult {
  protocol: typeof PROTOCOL_VERSION
  hostType: string
  displayName: string
  capabilities: Record<string, boolean>
  pid: number
  uptimeMs: number
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  UnsupportedCapability: -32001,
  NotConnected: -32002,
  UnknownSubscription: -32003,
  AuthFailed: -32004,
  HostLost: -32005,
  Timeout: -32008,
} as const

export type RpcErrorCodeValue = (typeof RpcErrorCode)[keyof typeof RpcErrorCode]

/**
 * Translate a host subsystem error into a stable RPC error code. Falls
 * back to `InternalError` for unknown errors so unexpected throws still
 * surface a parseable response (the original message goes in `message`).
 */
export function errorToRpc(err: unknown): RpcError {
  if (err instanceof UnsupportedCapabilityError) {
    return { code: RpcErrorCode.UnsupportedCapability, message: err.message }
  }
  if (err instanceof NotConnectedError) {
    return { code: RpcErrorCode.NotConnected, message: err.message }
  }
  if (err instanceof HostAuthError) {
    return { code: RpcErrorCode.AuthFailed, message: err.message }
  }
  if (err instanceof Error) {
    return { code: RpcErrorCode.InternalError, message: err.message }
  }
  return { code: RpcErrorCode.InternalError, message: String(err) }
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/**
 * Try to parse raw WS text into a {@link RpcRequest}. Returns a
 * fully-formed RPC error response when the payload is malformed.
 *
 * `null` is returned only for the "no id, nothing to reply to" case (a
 * raw event or garbage that isn't a request).
 */
export function tryParseRequest(raw: string | ArrayBuffer | Uint8Array): RpcRequest | RpcError | null {
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { code: RpcErrorCode.ParseError, message: 'Invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { code: RpcErrorCode.InvalidRequest, message: 'Request must be a JSON object' }
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.method !== 'string') {
    return { code: RpcErrorCode.InvalidRequest, message: 'Missing method' }
  }
  if (typeof obj.id !== 'string' && typeof obj.id !== 'number') {
    return { code: RpcErrorCode.InvalidRequest, message: 'Missing id' }
  }
  // `method` is a wire string here — the server validates against
  // `RpcMethod` via `narrowMethod` before invoking `dispatch`.
  return { id: obj.id, method: obj.method as RpcMethod, params: obj.params }
}

/**
 * Try to parse raw WS text into an {@link RpcEvent}. Returns null when
 * the payload isn't an event (i.e. it's a request/response — the caller
 * should route differently).
 */
export function tryParseEvent(raw: string | ArrayBuffer | Uint8Array): RpcEvent | null {
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.event !== 'string') return null
  return { event: obj.event, data: obj.data }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a successful response envelope. */
export function ok(id: string | number, result: unknown): RpcResponse {
  return { id, result }
}

/** Build an error response envelope. */
export function err(id: string | number, error: RpcError): RpcResponse {
  return { id, error }
}

/** Build a server-pushed event envelope. */
export function event(name: string, data: unknown): RpcEvent {
  return { event: name, data }
}