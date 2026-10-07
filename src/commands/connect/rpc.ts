import type { SandstoneConfig } from 'sandstone'
import { HostAuthError, NotConnectedError, UnsupportedCapabilityError } from '../../hosts/errors.js'
import type { HostLogLine } from '../../hosts/types.js'
import { decodeRpc } from './codec.js'
import type { WaitForLogSettlement, LogPattern } from './wait-log.js'

export const PROTOCOL_VERSION = 1

export const SUBPROTOCOL_PREFIX = 'sandstone-connect-v1.'

/**
 * Per-method RPC request payload. Methods that take no params use
 * `void`; methods with a dedicated `*Params` interface use it
 * directly. Used by `RpcRequest<M>['params']` so each request is
 * fully typed against the method it carries.
 */
export interface RpcMethodParams {
  ping: void
  startServer: void
  stopServer: void
  readFile: ReadFileParams
  writeFile: WriteFileParams
  executeRawCommand: ExecuteRawCommandParams
  reloadResources: void
  waitForLog: WaitForLogParams
  unwaitForLog: UnwaitForLogParams
  publishTriggerBuild: void
  cancelTriggerBuild: void
  setBuildMode: SetBuildModeParams
  publishTestComplete: TestState
  getTestState: void
  attachLog: AttachLogParams
  unattach: UnattachParams
  shutdown: void
  getActiveConfig: void
  getBuildOutputTree: GetBuildOutputTreeParams
  readBuildLog: ReadBuildLogParams
  readTestLog: ReadBuildLogParams
  readServerLog: ReadServerLogParams
  readClientLog: ReadClientLogParams
  publishConfig: PublishConfigParams
  publishLog: PublishLogParams
  publishRebuild: PublishRebuildParams
  getRebuildState: void
  publishWatcherStatus: PublishWatcherStatusParams
  getWatcherStatus: void
  streamEnd: StreamEndParams
}

/**
 * Per-method RPC response payload — the value the server returns on
 * the wire for a given method. Mirrors `RpcMethodParams` so callers
 * (e.g. `Client.call<M>`) can index both sides off the same `M`
 * without re-stating the result type at every call site.
 *
 * Methods that don't return a payload (just signal "ok") are mapped
 * to `void`. `attachLog` returns the bare `{ subscriptionId }` over
 * the wire; the rich `AttachLogSubscription` wrapper is built on the
 * client side from that.
 */
export interface RpcMethodResults {
  ping: PingResult
  startServer: void
  stopServer: void
  readFile: RpcReadFileStream
  writeFile: WriteFileResult
  executeRawCommand: ExecuteRawCommandResult
  reloadResources: void
  waitForLog: WaitForLogResult
  unwaitForLog: void
  publishTriggerBuild: PublishTriggerBuildResult
  cancelTriggerBuild: CancelTriggerBuildResult
  setBuildMode: SetBuildModeResult
  publishTestComplete: void
  getTestState: GetTestStateResult
  attachLog: { subscriptionId: string }
  unattach: void
  shutdown: void
  getActiveConfig: GetActiveConfigResult
  getBuildOutputTree: GetBuildOutputTreeResult
  readBuildLog: ReadBuildLogResult
  readTestLog: ReadBuildLogResult
  readServerLog: ReadBuildLogResult
  readClientLog: ReadClientLogResult
  publishConfig: void
  publishLog: void
  publishRebuild: void
  getRebuildState: GetRebuildStateResult
  publishWatcherStatus: void
  getWatcherStatus: GetWatcherStatusResult
  streamEnd: void
}

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  id: string | number
  method: M
  params?: RpcMethodParams[M]
}

/** Every RPC method the daemon understands. */
export type RpcMethod =
  | 'ping'
  | 'startServer'
  | 'stopServer'
  | 'readFile'
  | 'writeFile'
  | 'executeRawCommand'
  | 'reloadResources'
  | 'waitForLog'
  | 'unwaitForLog'
  | 'publishTriggerBuild'
  | 'cancelTriggerBuild'
  | 'setBuildMode'
  | 'publishTestComplete'
  | 'getTestState'
  | 'attachLog'
  | 'unattach'
  | 'shutdown'
  | 'getActiveConfig'
  | 'getBuildOutputTree'
  | 'readBuildLog'
  | 'readTestLog'
  | 'readServerLog'
  | 'readClientLog'
  | 'publishConfig'
  | 'publishLog'
  | 'publishRebuild'
  | 'getRebuildState'
  | 'publishWatcherStatus'
  | 'getWatcherStatus'
  | 'streamEnd'

/**
 * Union of every possible RPC handler return type. `dispatch` and
 * `route` both return this; the server wraps the value in an
 * `RpcResponse` envelope regardless of which member it is.
 */
export type RpcResult =
  | PingResult
  | RpcReadFileStream
  | ExecuteRawCommandResult
  | WaitForLogResult
  | AttachLogResult
  | GetActiveConfigResult
  | GetBuildOutputTreeResult
  | ReadBuildLogResult
  | ReadBuildLogResult
  | ReadBuildLogResult
  | ReadClientLogResult
  | GetRebuildStateResult
  | GetWatcherStatusResult
  | PublishTriggerBuildResult
  | CancelTriggerBuildResult
  | GetTestStateResult
  | SetBuildModeResult
  | void

/**
 * Server → client response. Exactly one of `result` / `error` is set.
 * `result` may be `null` only as the response to the in-flight request
 * when the daemon is shutting down (`ShutdownSignal`) — see server.ts.
 */
export interface RpcResponse {
  id: string | number
  result?: RpcResult | null
  error?: RpcError
}

export interface RpcEventMap {
  welcome: { protocol: typeof PROTOCOL_VERSION; hostType: string; displayName: string; capabilities: Record<string, boolean>; pid: number; startedAt: string }
  daemonShutdown: { reason: 'signal' | 'shutdown-rpc' | 'host-lost' }
  log: { subscriptionId: string; lines: HostLogLine[] }
  hostState: { state: 'connected' | 'disconnected' | 'lost'; reason?: string }
  configChanged: { saveConfig: SandstoneConfig['saveOptions'] | undefined; mode: 'pack' | 'library'; configPath: string; detectedAt: string }
  rebuildComplete: { buildCount: number; errorCount: number; warningCount: number; fileCount: number; at: string; state: 'complete' | 'failed'; message?: string }
  streamEnd: { streamId: string; bytes: number }
  streamError: { streamId: string; code: number; message: string }
  triggerBuild: { at: string }
  cancelTriggerBuild: { at: string }
  setBuildMode: { mode: 'normal' | 'test'; at: string }
}

export type RpcEvent = (
  | { event: 'welcome'; data: RpcEventMap['welcome'] }
  | { event: 'daemonShutdown'; data: RpcEventMap['daemonShutdown'] }
  | { event: 'log'; data: RpcEventMap['log'] }
  | { event: 'hostState'; data: RpcEventMap['hostState'] }
  | { event: 'configChanged'; data: RpcEventMap['configChanged'] }
  | { event: 'rebuildComplete'; data: RpcEventMap['rebuildComplete'] }
  | { event: 'streamEnd'; data: RpcEventMap['streamEnd'] }
  | { event: 'streamError'; data: RpcEventMap['streamError'] }
  | { event: 'triggerBuild'; data: RpcEventMap['triggerBuild'] }
  | { event: 'cancelTriggerBuild'; data: RpcEventMap['cancelTriggerBuild'] }
  | { event: 'setBuildMode'; data: RpcEventMap['setBuildMode'] }
)

export type RpcEventName = keyof RpcEventMap

const RPC_EVENT_TAGS = [
  'welcome',
  'daemonShutdown',
  'log',
  'hostState',
  'configChanged',
  'rebuildComplete',
  'streamEnd',
  'streamError',
  'triggerBuild',
  'cancelTriggerBuild',
  'setBuildMode',
] as const satisfies readonly RpcEventName[]
const RPC_EVENT_TAG_SET = new Set<RpcEventName>(RPC_EVENT_TAGS)

export type WelcomeEvent = RpcEventMap['welcome']

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export interface ReadFileParams {
  path: string
}
export interface RpcReadFileStream {
  /** 16-byte streamId hex-encoded. */
  streamId: string
  /** Best-effort size from fs.stat (may be unknown). */
  totalSize?: number
}

export interface WriteFileParams {
  path: string
  /**
   * Optional final byte count. Hosts whose upload protocol needs
   * a known size up front (e.g. MCSManager's chunked-upload
   * handshake) stream chunks through `upload-piece` when this is
   * supplied; otherwise they buffer until close. Hosts with
   * native streaming backends ignore it.
   */
  size?: number
}
export interface WriteFileResult {
  /** 16-byte streamId hex-encoded. */
  streamId: string
}

export interface StreamEndEvent {
  event: 'streamEnd'
  data: {
    streamId: string
    bytes: number
  }
}

/** Client → server `streamEnd` ack. Distinct from `StreamEndEvent`
 *  (server → client) because the ack may omit `bytes` when the client
 *  never wrote anything. */
export interface StreamEndParams {
  streamId: string
  bytes?: number
}

export interface StreamErrorEvent {
  event: 'streamError'
  data: {
    streamId: string
    code: number
    message: string
  }
}

export interface ExecuteRawCommandParams {
  command: string,
  /**
   * Optional log pattern to watch for. When set, the daemon registers
   * the pattern on the host's log stream BEFORE running the command.
   */
  waitFor?: LogPattern,
}

export interface ExecuteRawCommandResult {
  /** Best-effort; providers may return '' if response capture is unreliable. */
  output: string,
  /** Populated only when `params.waitFor` was set. Resolves to the captured lines. */
  logResult?: Promise<string[]>,
  /** Populated only when `params.waitFor` was set. Cancels the matcher. */
  cancel?: () => Promise<void>,
  /** Populated only when `params.waitFor` was set. UUID for the registered pattern. */
  patternUUID?: string,
}

export interface WaitForLogParams {
  patterns: Array<{
    kind: 'endsWith' | 'includes' | 'glob' | 'regex'
    value: string
    timeoutMs?: number
    closingLine?: {
      kind: 'endsWith' | 'includes' | 'glob' | 'regex'
      value: string
      timeoutMs?: number
    }
  }>
}

export interface WaitForLogResult {
  subscriptionId: string
  patternUUIDs: string[]
}

export interface UnwaitForLogParams {
  subscriptionId: string
}

export type WaitForLogEvent = WaitForLogSettlement & {
  subscriptionId: string
  at: string
}

export interface AttachLogParams {
  /** If specified, only matching lines are forwarded. */
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

export interface GetActiveConfigResult {
  mode: 'pack' | 'library'
  configPath: string
  saveConfig: SandstoneConfig['saveOptions'] | undefined
  clientLogAvailable: boolean
  outputDir: string
  projectRoot: string
  loadedAt: string
}

export interface GetBuildOutputTreeParams {
  /** Subpath relative to `outputDir`. Empty/absent = list root. */
  path?: string
  /** Cap on entries returned (default 1000). */
  limit?: number
}

export interface BuildOutputEntry {
  path: string
  isDirectory: boolean
}

export interface GetBuildOutputTreeResult {
  baseDir: string
  entries: BuildOutputEntry[]
  truncated: boolean
}

export interface ReadBuildLogParams {
  tail: number | null
  maxLines: number | null
  range: { from: number; to: number } | null
  since: number | null
  until: number | null
}

export interface ReadBuildLogResult {
  path: string
  lines: string[]
  totalLines: number
  /**
   * Number of lines that matched the filter. `lines.length` may be
   * less than this when `tail`/`maxLines` truncated the result.
   */
  matchedLines: number
  oldestTs: string | null
  newestTs: string | null
  truncated: boolean
}

export interface ReadServerLogParams {
  tail: number | null
  maxLines: number | null
  range: { from: number; to: number } | null
  since: number | null
  until: number | null
}

export interface ReadClientLogParams {
  tail: number | null
  maxLines: number | null
  range: { from: number; to: number } | null
}

export interface ReadClientLogResult {
  path: string
  lines: string[]
  totalLines: number
  matchedLines: number
  truncated: boolean
}

export interface PublishConfigParams {
  mode: 'pack' | 'library'
  configPath: string
  saveConfig: SandstoneConfig['saveOptions'] | undefined
  outputDir: string
  projectRoot: string
  loadedAt: string
}

export interface LogLineEntry {
  line: string
  ts: number
  stream: 'stdout' | 'stderr'
}

export interface PublishLogParams {
  entries: LogLineEntry[]
  /** Defaults to `build`. */
  target?: 'build' | 'test' | 'server'
}

export interface RebuildState {
  state: 'started' | 'complete' | 'failed'
  fileCount: number
  errorCount: number
  warningCount: number
  at: string
  message?: string
  /** True when the watcher was in tests-mode for this build — a
   *  `sand test` run will start after the daemon reload completes.
   *  Subscribe to `sandstone://test-state` to receive the test summary. */
  testingMode?: boolean
}

export interface PublishRebuildParams extends RebuildState {}

export interface WatcherStatus {
  connected: boolean
  mode: 'pack' | 'library' | null
  manual: boolean
  testingMode: boolean
  path: string
  pid: number
  at: string
}

export interface PublishWatcherStatusParams extends WatcherStatus {}

export interface PublishTriggerBuildResult {
  triggered: boolean
}

export interface TriggerBuildEvent {
  at: string
}

export interface GetWatcherStatusResult {
  status: WatcherStatus | null
}

export interface GetRebuildStateResult {
  state: RebuildState | null
}

export interface CancelTriggerBuildEvent {
  event: 'cancelTriggerBuild'
  data: {
    at: string
  }
}

export interface CancelTriggerBuildResult {
  cancelled: boolean
}

export interface SetBuildModeParams {
  mode: 'normal' | 'test',
}

export interface SetBuildModeResult {
  applied: boolean,
}

export interface TestState {
  state: 'started' | 'complete' | 'failed' | 'cancelled'
  pass: number
  fail: number
  durationSec: number
  at: string
  message?: string
}

export interface GetTestStateResult {
  state: TestState | null
}

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
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    // Plain RpcError-shaped throwable (from `throw rpcError(...)`).
    return { code: Number((err as { code: unknown }).code), message: String((err as { message: unknown }).message) }
  }
  return { code: RpcErrorCode.InternalError, message: String(err) }
}

export function tryParseRequest(raw: string | ArrayBuffer | Uint8Array): RpcRequest | RpcError | null {
  const buf = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
  let parsed: unknown
  try {
    parsed = decodeRpc(buf).value
  } catch {
    return { code: RpcErrorCode.ParseError, message: 'Invalid msgpack' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { code: RpcErrorCode.InvalidRequest, message: 'Request must be an object' }
  }
  const obj = parsed as Record<string, unknown>
  const hasMethod = typeof obj.method === 'string'
  const hasId = typeof obj.id === 'string' || typeof obj.id === 'number'
  if (!hasMethod && !hasId) return null
  if (!hasMethod) {
    return { code: RpcErrorCode.InvalidRequest, message: 'Missing method' }
  }
  if (!hasId) return null
  return { id: obj.id as string | number, method: obj.method as RpcMethod, params: obj.params as RpcMethodParams[RpcMethod] | undefined }
}

export function tryParseEvent(raw: string | ArrayBuffer | Uint8Array): RpcEvent | null {
  const buf = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
  let parsed: unknown
  try {
    parsed = decodeRpc(buf).value
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.event !== 'string') return null
  if (!RPC_EVENT_TAG_SET.has(obj.event as RpcEventName)) return null
  return { event: obj.event as RpcEventName, data: obj.data as never }
}

export function tryParseMethodNotification(raw: string | ArrayBuffer | Uint8Array): { method: string; params: unknown } | null {
  const buf = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
  let parsed: unknown
  try {
    parsed = decodeRpc(buf).value
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.method !== 'string') return null
  if ('id' in obj) return null
  return { method: obj.method, params: obj.params }
}

export function ok(id: string | number, result: RpcResult | null): RpcResponse {
  return { id, result }
}

export function err(id: string | number, error: RpcError): RpcResponse {
  return { id, error }
}

export function event<K extends RpcEventName>(name: K, data: RpcEventMap[K]): { event: K; data: RpcEventMap[K] } {
  return { event: name, data }
}

/**
 * Names + payload shapes for fire-and-forget JSON-RPC notifications.
 * Daemon emits `waitForLog` to clients; the `notifications/resources/updated`
 * entry implements the MCP resource-updated protocol the daemon fans
 * to its MCP subscribers. Add a key here when introducing a new
 * notification — `notification<M>()` will then enforce the payload.
 */
export interface RpcNotificationMap {
  waitForLog: WaitForLogEvent
  'notifications/resources/updated': { uri: string }
}

export type RpcNotificationName = keyof RpcNotificationMap

export function notification<M extends RpcNotificationName>(
  method: M,
  params: RpcNotificationMap[M],
): { jsonrpc: '2.0', method: M, params: RpcNotificationMap[M] } {
  return { jsonrpc: '2.0', method, params }
}

/**
 * Wire envelope for a single JSON-RPC request, materialised as a
 * discriminated union so the discriminator narrows the payload per
 * variant. The generic `RpcRequest<M>` is still used at function call
 * sites (where the `M` literal is in scope); this type exists so
 * `WsMessage` consumers can switch on `kind` + `method`/`event` and
 * get the typed payload without a manual cast.
 */
export type RpcRequestMessage = {
  [M in RpcMethod]: { kind: 'request', id: string | number, method: M, params?: RpcMethodParams[M] }
}[RpcMethod]

/** See {@link RpcRequestMessage} — same rationale for events. */
export type RpcEventMessage = {
  [E in RpcEventName]: { kind: 'event', event: E, data: RpcEventMap[E] }
}[RpcEventName]

/** See {@link RpcRequestMessage} — same rationale for notifications. */
export type RpcNotificationMessage = {
  [N in RpcNotificationName]: { kind: 'notification', method: N, params: RpcNotificationMap[N] }
}[RpcNotificationName]

export type WsMessage =
  | RpcRequestMessage
  | { kind: 'response', id: string | number, result?: RpcResult | null, error?: RpcError }
  | RpcEventMessage
  | RpcNotificationMessage

export function classifyWsMessage(raw: string | Uint8Array): WsMessage | null {
  const buf = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw
  if (typeof raw === 'string') {
    throw new Error('this should never happen')
  }
  let parsed: unknown
  try {
    parsed = decodeRpc(buf).value
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if ('id' in obj && ('result' in obj || 'error' in obj)) {
    return { kind: 'response', id: obj.id as string | number, result: obj.result as RpcResult | undefined, error: obj.error as RpcError | undefined }
  }
  if (typeof obj.event === 'string') {
    // Wire boundary: `obj.event` is a plain string from JSON; cast to
    // the typed discriminated union at the only point we trust the
    // wire shape. Consumers narrow via `msg.event` from here.
    return { kind: 'event', event: obj.event as RpcEventMessage['event'], data: obj.data as RpcEventMessage['data'] } as WsMessage
  }
  if ('id' in obj && typeof obj.method === 'string') {
    return { kind: 'request', id: obj.id as string | number, method: obj.method as RpcRequestMessage['method'], params: obj.params as RpcRequestMessage['params'] } as WsMessage
  }
  if (typeof obj.method === 'string') {
    return { kind: 'notification', method: obj.method as RpcNotificationMessage['method'], params: obj.params as RpcNotificationMessage['params'] } as WsMessage
  }
  return null
}