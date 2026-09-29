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

import { HostAuthError, NotConnectedError, UnsupportedCapabilityError } from '../../hosts/errors.js'
import type { ActiveSaveConfig } from '../../utils/activeSaveConfig.js'

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
  | 'getActiveConfig'
  | 'getBuildOutputTree'
  | 'readBuildLog'
  | 'readTestLog'
  | 'readServerLog'
  | 'getWatchedFiles'
  | 'publishConfig'
  | 'publishLog'
  | 'publishRebuild'
  | 'getRebuildState'
  | 'publishWatcherStatus'
  | 'getWatcherStatus'
  | 'publishTriggerBuild'

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
  | GetActiveConfigResult
  | GetBuildOutputTreeResult
  | ReadBuildLogResult
  | ReadTestLogResult
  | ReadServerLogResult
  | GetWatchedFilesResult
  | GetRebuildStateResult
  | GetWatcherStatusResult
  | PublishTriggerBuildResult
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

/**
 * Sent to every open WS session when the daemon begins teardown — for
 * any reason (SIGINT, EOF, `--shutdown` RPC, host member disconnected).
 * Clients should flush pending state and close promptly; the daemon
 * proceeds with the rest of teardown regardless. `reason` is one of
 * `'signal' | 'shutdown-rpc' | 'host-lost'` so clients can log a
 * sensible message.
 */
export interface DaemonShutdownEvent {
  reason: 'signal' | 'shutdown-rpc' | 'host-lost'
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

/**
 * Pushed whenever the active `sandstone.config.ts` changes — either at
 * daemon startup (one immediate event after `welcome`) or after a hot
 * reload. Clients (notably the `sand mcp` server) use this to refresh
 * resource contents without polling.
 */
export interface ConfigChangedEvent {
  /** Mirrors {@link GetActiveConfigResult.saveConfig}. */
  saveConfig: ActiveSaveConfig | undefined
  mode: 'pack' | 'library'
  configPath: string
  /** ISO timestamp of when the reload was detected. */
  detectedAt: string
}

/**
 * Pushed after the watcher finishes a build cycle. Includes summary
 * stats so clients can update their `last-build` resource without
 * re-reading the output tree.
 */
export interface RebuildCompleteEvent {
  outputDir: string
  durationMs: number
  fileCount: number
  errorCount: number
  warningCount: number
  /** ISO timestamp of build completion. */
  completedAt: string
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

/**
 * The currently active `sandstone.config.ts` the daemon loaded on
 * startup, plus the project shape it implies (mode, output paths).
 *
 * `mode` is auto-detected: pack mode when `<root>/sandstone.config.ts`
 * exists, library mode when only `<root>/test/sandstone.config.ts`
 * does. Library mode disables pack-deploy-related features
 * (`saveOptions.world` etc. are usually empty).
 *
 * `saveConfig` is the resolved deploy config — what the watcher will
 * actually deploy to (world, client/server paths, root install).
 * `undefined` when no watcher has published and the boot-time load
 * didn't find one.
 *
 * `outputDir` resolves to the directory the watcher's build writes
 * into — `<root>/.sandstone/output` for pack mode, `<root>/test/.sandstone/output`
 * for library mode.
 */
export interface GetActiveConfigResult {
  mode: 'pack' | 'library'
  /** Absolute path to the loaded config file. */
  configPath: string
  /** Resolved deploy config (post-CLI-override). */
  saveConfig: ActiveSaveConfig | undefined
  /** Absolute path to the build output directory. */
  outputDir: string
  /** Absolute path to the project root. */
  projectRoot: string
  /** ISO timestamp of when this config was loaded. */
  loadedAt: string
}

export interface GetBuildOutputTreeParams {
  /** Subpath relative to `outputDir`. Empty/absent = list root. */
  path?: string
  /** Cap on entries returned (default 1000). */
  limit?: number
}

export interface BuildOutputEntry {
  /** Path relative to `outputDir`. */
  path: string
  size: number
  /** ISO timestamp of last modification. */
  mtime: string
  /** `true` for directories (mtime is the dir's, size always 0). */
  isDirectory: boolean
}

export interface GetBuildOutputTreeResult {
  /** Absolute base directory these paths are relative to. */
  baseDir: string
  entries: BuildOutputEntry[]
  /** Set when more entries exist beyond `limit`. */
  truncated: boolean
}

export interface ReadBuildLogParams {
  /**
   * All six fields are present in every MCP wire call (URI template
   * matching requires it). `null` is the wire shape for "no filter" —
   * sent over the wire so RPC servers can rely on the field being
   * defined. The MCP resource layer translates the URI's `-1`
   * sentinel to `null` before sending.
   *
   *   - `tail`: max lines returned when no range filter matches more.
   *     `null` = use default (200).
   *   - `maxLines`: hard cap on lines returned. `null` = use default
   *     (1000).
   *   - `range`: line-ID range (inclusive). `null` = no range filter.
   *     `from: 0` = most recent line; IDs count backwards.
   *   - `since`: lower time bound in seconds-relative-to-now. `null`
   *     = no time filter.
   *   - `until`: upper time bound in seconds-relative-to-now. `null`
   *     = no time filter.
   */
  tail: number | null
  maxLines: number | null
  range: { from: number; to: number } | null
  since: number | null
  until: number | null
}

export interface ReadBuildLogResult {
  /**
   * Canonical log path (the watch.log file the watcher writes to disk
   * for humans). Returned for display purposes; the daemon does NOT
   * read this file to answer the call — content comes from the
   * in-memory buffer populated via `publishLog`.
   */
  path: string
  /**
   * Lines from the daemon's in-memory log buffer (filtered by `range`
   * and/or `since`/`until` when those were supplied).
   */
  lines: string[]
  /**
   * Total lines currently buffered (pre-filter). Useful for callers
   * to know how much they're slicing from.
   */
  totalLines: number
  /**
   * Number of lines that matched the filter. `lines.length` may be
   * less than this when `tail`/`maxLines` truncated the result.
   */
  matchedLines: number
  /** ISO timestamp of the oldest line in `lines`, or null if empty. */
  oldestTs: string | null
  /** ISO timestamp of the newest line in `lines`, or null if empty. */
  newestTs: string | null
  /** `true` if the result was truncated by `tail` or `maxLines`. */
  truncated: boolean
}

/**
 * Test-log result shares the shape with build-log (both are filtered
 * slices of an in-memory buffer). Distinct type for wire clarity —
 * each method returns its own type even though they look the same.
 */
export type ReadTestLogResult = ReadBuildLogResult

/**
 * Server-log query parameters. `tail` is the max lines returned when
 * no range filter matches more; `null` = use default (200).
 * `maxLines` hard-caps the response; `null` = default (1000). Range
 * and time filters intersect.
 */
export interface ReadServerLogParams {
  tail: number | null
  maxLines: number | null
  range: { from: number; to: number } | null
  since: number | null
  until: number | null
}

/**
 * Server-log result. Same shape as {@link ReadBuildLogResult} but
 * served from the daemon's host-log buffer (populated via the host's
 * `attachLog` subscription at daemon boot, NOT from `logs/latest.log`
 * on disk — that's only kept as a fallback for hosts without an
 * in-memory stream).
 */
export type ReadServerLogResult = ReadBuildLogResult

export interface GetWatchedFilesResult {
  files: Array<{
    /** Absolute path. */
    path: string
    /** Last event type observed. */
    lastEvent: 'create' | 'update' | 'delete'
    /** ISO timestamp. */
    lastEventAt: string
  }>
}

/**
 * Watcher → daemon push of the current saveConfig. Called by
 * `sand watch` on boot and after every hot-reload of
 * `sandstone.config.ts`. The daemon updates its in-memory state and
 * broadcasts {@link ConfigChangedEvent} to every other connected
 * client so they (typically `sand mcp`) can refresh.
 *
 * `saveConfig` is the resolved deploy config after CLI/env overrides
 * are applied — see {@link ActiveSaveConfig} in `utils/activeSaveConfig.ts`.
 */
export interface PublishConfigParams {
  mode: 'pack' | 'library'
  configPath: string
  saveConfig: ActiveSaveConfig | undefined
  outputDir: string
  projectRoot: string
  loadedAt: string
}

/**
 * One buffered log line — the raw text plus the timestamp the
 * watcher stamped when it emitted the line. Timestamps come from the
 * source (intrinsic) rather than the daemon stamping on receipt so
 * the value reflects "when the event happened" rather than "when the
 * network packet landed".
 */
export interface LogLineEntry {
  line: string
  /** Unix epoch ms. */
  ts: number
}

/**
 * Log stream target. Each stream has its own bounded buffer in the
 * daemon; readers specify which one they want.
 *  - `build` — watcher's `sand watch` log. Pushed via `publishLog`
 *    while `sand watch` is running.
 *  - `test` — future test runner log. Buffer exists today (so the
 *    resource supports the same filtering shape as build) but no
 *    backend pushes to it yet.
 *  - `server` — Minecraft server stdout. The daemon subscribes to its
 *    own host's `attachLog` at boot and pushes every line into this
 *    buffer so `sandstone://server-log` works without touching the
 *    on-disk log file (and without requiring a watcher).
 */
export type LogStreamTarget = 'build' | 'test' | 'server'

/**
 * Watcher → daemon push of log lines. The daemon keeps a bounded
 * circular buffer (last ~1000 lines) per target; the matching
 * `readBuildLog` / `readTestLog` returns slices of that buffer, never
 * reads the underlying file itself. The on-disk files (e.g.
 * `watch.log`) are only kept for humans tailing them directly.
 */
export interface PublishLogParams {
  entries: LogLineEntry[]
  /** Which stream to push to. Defaults to `build`. */
  target?: LogStreamTarget
}

/**
 * Watcher → daemon push of the current build's lifecycle state.
 * Watchers call this at start (`state: 'started'`) and at end
 * (`state: 'complete'` or `'failed'`). The daemon caches the latest
 * snapshot and fires `notifications/resources/updated` for the
 * synthetic `sandstone://rebuild-state` resource so subscribed MCP
 * clients see start/finish events in real time.
 *
 * MCP clients subscribe via `resources/subscribe
 * sandstone://rebuild-state` and either read the current snapshot via
 * `resources/read` or react to the `notifications/resources/updated`
 * push to take action (e.g. "the rebuild finished, fetch the new
 * `build-output` tree").
 */
export interface RebuildState {
  state: 'started' | 'complete' | 'failed'
  /** Files in the rebuilt output. `0` on `started`. */
  fileCount: number
  /** Errors surfaced during the build. `0` on success. */
  errorCount: number
  /** Non-fatal warnings. */
  warningCount: number
  /** ISO timestamp of the state push. */
  at: string
  /** Optional human-readable detail (failure reason, build message). */
  message?: string
}

export interface PublishRebuildParams extends RebuildState {}

/**
 * Snapshot of the watcher's runtime status, published by `sand watch`
 * when it connects to the daemon. The daemon holds the latest snapshot
 * and flips `connected` to `false` when the watcher's WS session ends.
 *
 * Exposed via the synthetic MCP resource `sandstone://watcher-status`
 * so agents can answer "is a watcher currently running, and in what
 * mode?" without having to spawn their own `sand watch`.
 */
export interface WatcherStatus {
  /** `true` while the watcher's WS session is live. `false` after disconnect. */
  connected: boolean
  /**
   * Project mode the watcher is running in. `null` until the watcher
   * publishes its first snapshot.
   */
  mode: 'pack' | 'library' | null
  /** Whether the watcher was invoked with `--manual` (changes queue until the user runs them). */
  manual: boolean
  /** Absolute path the watcher is monitoring. */
  path: string
  /** Watcher process PID, useful for debugging "is the watcher alive?". */
  pid: number
  /** ISO timestamp of when this snapshot was pushed. */
  at: string
}

export interface PublishWatcherStatusParams extends WatcherStatus {}

/**
 * MCP → daemon → watcher trigger. The MCP `runWorkspaceBuild` tool
 * calls this when it determines a build should fire (watcher in
 * manual mode). The daemon broadcasts a `triggerBuild` event; the
 * watcher subscribes and runs its rebuild path.
 */
export interface PublishTriggerBuildResult {
  /** `true` when the daemon accepted the trigger and will fan it out. */
  triggered: boolean
}

/**
 * Server-pushed event: "please rebuild now". Watcher subscribes via
 * `client.onTriggerBuild` and reacts by running its rebuild path
 * (consuming any pending changes in manual mode).
 */
export interface TriggerBuildEvent {
  /** ISO timestamp the daemon accepted the trigger. */
  at: string
}

export interface GetWatcherStatusResult {
  /**
   * Current watcher status. `null` if no watcher has connected since
   * the daemon started — the agent sees `null` and knows nothing is
   * running (no need to fall back to a default).
   */
  status: WatcherStatus | null
}

/**
 * Return the latest build state the watcher pushed. `null` if no
 * `publishRebuild` has landed yet. MCP server reads this when
 * serving `resources/read sandstone://rebuild-state`.
 */
export interface GetRebuildStateResult {
  state: RebuildState | null
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
 *
 * Plain objects shaped like `{code, message}` (the shape returned by
 * `rpcError(...)` and `RpcHandlerError.rpc`) pass through verbatim —
 * otherwise `String(err)` would render as `"[object Object]"`.
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
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    // Plain RpcError-shaped throwable (from `throw rpcError(...)`).
    return { code: Number((err as { code: unknown }).code), message: String((err as { message: unknown }).message) }
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

/**
 * Build a server-pushed MCP notification envelope (JSON-RPC 2.0
 * notification — no `id`, no response expected). Used to fan out
 * `notifications/resources/updated` and friends to subscribed clients.
 */
export function notification(method: string, params?: unknown): {
  jsonrpc: '2.0'
  method: string
  params?: unknown
} {
  const env: { jsonrpc: '2.0'; method: string; params?: unknown } = { jsonrpc: '2.0', method }
  if (params !== undefined) env.params = params
  return env
}