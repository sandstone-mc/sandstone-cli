/**
 * RPC method dispatch.
 *
 * Maps `sand connect` RPC methods onto HostProvider capabilities. Each
 * method is a small `(host, params) => Promise<result>` thunk. Errors
 * are translated to stable RPC codes by {@link errorToRpc}.
 *
 * Pure — does not touch `Bun.serve` or WebSocket state. The server layer
 * wires this in per-connection.
 */

import {
  PROTOCOL_VERSION,
  errorToRpc,
  type AttachLogParams,
  type AttachLogResult,
  type ExecuteRawCommandParams,
  type ExecuteRawCommandResult,
  type PingResult,
  type ReadFileParams,
  type ReadFileResult,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
  type RpcResult,
  type RpcResponse,
  type StopServerParams,
  type UnattachParams,
  type WriteFileParams,
} from './rpc.js'
import type { SubscriptionRegistry } from './subscriptions.js'
import { RpcErrorCode } from './rpc.js'
import { Capability, capabilitiesToRecord } from '../../hosts/types.js'
import type { HostProvider, LogChunkHandler, ServerPath } from '../../hosts/types.js'

export interface DispatchContext {
  host: HostProvider
  subscriptions: SubscriptionRegistry
  ws: unknown
  /** Coalesce handler pushed by `attachLog`. Created per ws connection.
   *  `subscriptionId` tags the wire batch so the client can route to the
   *  matching subscription's `onLines` callback. `hostType` is set only
   *  by fan-out (`attachLogs`) handlers. */
  pushLog: (lines: string[], subscriptionId: string, hostType?: string) => void
  startedAt: number
}

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
  constructor(public readonly rpc: RpcError) {
    super(rpc.message)
    this.name = 'RpcHandlerError'
  }
}

/**
 * Dispatch one parsed request. Returns the handler's result value
 * (typed as the union {@link RpcResult}). Throws
 * {@link ShutdownSignal} for the `shutdown` RPC and
 * {@link RpcHandlerError} for any other handler error so the server
 * can react (the policy is: any handler error → shut the daemon down).
 */
export async function dispatch(
  ctx: DispatchContext,
  req: RpcRequest,
): Promise<RpcResult> {
  try {
    return await route(ctx, req.method, req.params)
  } catch (e) {
    if (e instanceof ShutdownSignal) throw e
    throw new RpcHandlerError(errorToRpc(e))
  }
}

/** Set of every valid method name — used by the server to narrow a wire-string `method` to {@link RpcMethod}. */
const KNOWN_METHODS: ReadonlySet<string> = new Set<RpcMethod>([
  'ping',
  'startServer',
  'stopServer',
  'readFile',
  'writeFile',
  'executeRawCommand',
  'attachLog',
  'attachLogs',
  'unattach',
  'shutdown',
])

/** Narrow a parsed-wire method string to {@link RpcMethod}, throwing on unknown. */
export function narrowMethod(method: string): RpcMethod {
  if (!KNOWN_METHODS.has(method)) {
    throw rpcError(RpcErrorCode.MethodNotFound, `Unknown method: ${method}`)
  }
  return method as RpcMethod
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Internal method→handler dispatch. Each case returns the typed result
 * for that method; the union via `RpcMethodResult[M]` keeps the
 * `dispatch<M>(req)` signature typesafe end-to-end.
 */
async function route(
  ctx: DispatchContext,
  method: RpcMethod,
  params: unknown,
): Promise<RpcResult> {
  // Exhaustiveness check at the bottom catches new methods without a
  // case here at compile time.
  switch (method) {
    case 'ping':
      return handlePing(ctx)
    case 'startServer':
      return handleStartServer()
    case 'stopServer':
      return handleStopServer(params)
    case 'readFile':
      return handleReadFile(params)
    case 'writeFile':
      return handleWriteFile(params)
    case 'executeRawCommand':
      return handleExecuteRawCommand(params)
    case 'attachLog':
      return handleAttachLog(ctx, params)
    case 'attachLogs':
      return handleAttachLogs(ctx, params)
    case 'unattach':
      return handleUnattach(ctx, params)
    case 'shutdown':
      throw new ShutdownSignal()
    default: {
      const _exhaustive: never = method
      void _exhaustive
      throw rpcError(RpcErrorCode.MethodNotFound, `Unknown method: ${method as string}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePing(ctx: DispatchContext): Promise<PingResult> {
  const caps = capabilitiesToRecord(ctx.host.capabilities)
  if (attachLogsCapability(ctx.host)) {
    caps.attachLogs = true
  }
  return {
    protocol: PROTOCOL_VERSION,
    hostType: ctx.host.type,
    displayName: ctx.host.displayName,
    capabilities: caps,
    pid: process.pid,
    uptimeMs: Date.now() - ctx.startedAt,
  }
}

/**
 * Surface `attachLogs` as an ad-hoc capability only when the host can
 * actually fan out across multiple logging members. Single-host daemons
 * and composites with one attachLog-capable member don't get the
 * capability — there's nothing to fan out to. Not in the Capability
 * enum because only the wire cares about it.
 *
 * Used by both the `ping` RPC handler and the `welcome` event sent at
 * WS connect time — clients decide between `attachLog` and `attachLogs`
 * based on the welcome, so both paths must agree.
 */
export function attachLogsCapability(host: HostProvider): boolean {
  const members = (host as unknown as { members?: readonly unknown[] }).members
  if (!Array.isArray(members)) return false
  if (typeof (host as unknown as { attachLogs?: unknown }).attachLogs !== 'function') return false
  let loggingCount = 0
  for (const m of members) {
    const member = m as { capabilities?: { has: (c: Capability) => boolean }; attachLog?: unknown }
    if (member.capabilities?.has(Capability.AttachLog) && typeof member.attachLog === 'function') {
      loggingCount++
      if (loggingCount >= 2) return true
    }
  }
  return false
}

async function handleStartServer(): Promise<void> {
  if (!capable(Capability.StartServer)) throw new UnsupportedCapabilityRpc(Capability.StartServer)
  await runHost((h) => (h.startServer ?? notImplemented(Capability.StartServer)).bind(h)())
}

async function handleStopServer(params: unknown): Promise<void> {
  if (!capable(Capability.StopServer)) throw new UnsupportedCapabilityRpc(Capability.StopServer)
  // Optional `{ timeoutSeconds?: number }`. We only forward it to the
  // provider if the config supports it — today no provider does, so the
  // field is parsed but ignored. Documented as a forward-compatible
  // hint.
  void (params as StopServerParams | undefined)
  await runHost((h) => (h.stopServer ?? notImplemented(Capability.StopServer)).bind(h)())
}

async function handleReadFile(params: unknown): Promise<ReadFileResult> {
  if (!capable(Capability.ReadFile)) throw new UnsupportedCapabilityRpc(Capability.ReadFile)
  const { path } = parseParams<ReadFileParams>(params, ['path'])
  const buf = await runHost<Buffer>((h) =>
    (h.readFile ?? notImplemented(Capability.ReadFile)).bind(h)(path as ServerPath),
  )
  return { data: buf.toString('base64'), size: buf.length }
}

async function handleWriteFile(params: unknown): Promise<void> {
  if (!capable(Capability.WriteFile)) throw new UnsupportedCapabilityRpc(Capability.WriteFile)
  const { path, data, encoding } = parseParams<WriteFileParams>(params, ['path', 'data'])
  const bytes = encoding === 'utf-8' ? Buffer.from(data, 'utf-8') : Buffer.from(data, 'base64')
  await runHost((h) => (h.writeFile ?? notImplemented(Capability.WriteFile)).bind(h)(path as ServerPath, bytes))
}

async function handleExecuteRawCommand(params: unknown): Promise<ExecuteRawCommandResult> {
  if (!capable(Capability.ExecuteRawCommand)) throw new UnsupportedCapabilityRpc(Capability.ExecuteRawCommand)
  const { command } = parseParams<ExecuteRawCommandParams>(params, ['command'])
  const output = await runHost<string>((h) =>
    (h.executeRawCommand ?? notImplemented(Capability.ExecuteRawCommand)).bind(h)(command),
  )
  return { output }
}

async function handleAttachLog(ctx: DispatchContext, params: unknown): Promise<AttachLogResult> {
  if (!capable(Capability.AttachLog)) throw new UnsupportedCapabilityRpc(Capability.AttachLog)
  const { regex } = parseParams<AttachLogParams>(params, [])
  const filter = regex ? new RegExp(regex) : null

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
  const subscription = await runHost((h) =>
    (h.attachLog ?? notImplemented('attachLog')).bind(h)(handler),
  )
  // Replace the placeholder unattach with the real provider thunk so the
  // ws close cascade (dropAllForWs) and explicit `unattach` RPCs both
  // reach the host's subscription.
  ctx.subscriptions.replaceUnattach(subscriptionId, () => subscription.unattach())
  return { subscriptionId }
}

/**
 * Fan-out variant of `attachLog`. Composite hosts with two or more
 * attachLog-capable members implement `attachLogs` to subscribe to every
 * member under one subscription; the fanout handler reports each
 * emitting host type so clients can label output.
 *
 * Only exists on fan-out daemons — a daemon with a single logging host
 * doesn't advertise the `attachLogs` capability and this handler is
 * never invoked. Lines are passed through unchanged; `hostType` rides
 * on the wire batch so the client can choose how (or whether) to label.
 */
async function handleAttachLogs(ctx: DispatchContext, params: unknown): Promise<AttachLogResult> {
  const { regex } = parseParams<AttachLogParams>(params, [])
  const filter = regex ? new RegExp(regex) : null

  const fanout = (ctx.host as unknown as {
    attachLogs?: (onChunk: (hostType: string, lines: string[]) => void) => Promise<{ unattach(): Promise<void> }>
  }).attachLogs

  if (!fanout) {
    // The `attachLogs` capability is only advertised by daemons that
    // actually fan out, so getting here means the capability record was
    // stale (daemon reconfigured mid-session). Reject with a stable RPC
    // code so the client falls back to `attachLog`.
    throw rpcError(RpcErrorCode.UnsupportedCapability, 'attachLogs not supported by this host')
  }

  const subscriptionId = ctx.subscriptions.registerWithId(
    crypto.randomUUID(),
    ctx.ws,
    async () => {},
  )

  const fanoutHandler = (hostType: string, lines: string[]) => {
    if (filter) {
      const matched = lines.filter((l) => filter.test(l))
      if (matched.length > 0) ctx.pushLog(matched, subscriptionId, hostType)
    } else {
      ctx.pushLog(lines, subscriptionId, hostType)
    }
  }
  const subscription = await runHost((h) =>
    ((h as unknown as { attachLogs?: typeof fanout }).attachLogs ?? notImplemented('attachLogs')).bind(h)(fanoutHandler),
  )
  // Wire the real unattach so the ws close cascade (dropAllForWs) tears
  // down the composite's fan-out subscription, not a no-op placeholder.
  ctx.subscriptions.replaceUnattach(subscriptionId, () => subscription.unattach())
  return { subscriptionId }
}

async function handleUnattach(ctx: DispatchContext, params: unknown): Promise<void> {
  const { subscriptionId } = parseParams<UnattachParams>(params, ['subscriptionId'])
  const ok = await ctx.subscriptions.unattach(subscriptionId)
  if (!ok) throw rpcError(RpcErrorCode.UnknownSubscription, `Unknown subscription: ${subscriptionId}`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let currentHost: HostProvider | null = null
function capable(cap: Capability): boolean {
  if (!currentHost) return false
  return currentHost.capabilities.has(cap)
}

/**
 * Scope `currentHost` for the duration call an `op(host)` so `capable`
 * can read it without threading the host through every helper.
 */
async function runHost<T>(op: (h: HostProvider) => Promise<T>): Promise<T> {
  const host = currentHost
  if (!host) throw rpcError(RpcErrorCode.NotConnected, 'No host available')
  return op(host)
}

/** Set the active host before dispatching; restore on the way out. */
export async function withHost<T>(host: HostProvider, fn: () => Promise<T>): Promise<T> {
  const prev = currentHost
  currentHost = host
  try {
    return await fn()
  } finally {
    currentHost = prev
  }
}

function parseParams<T extends object>(
  params: unknown,
  required: Array<keyof T>,
): T {
  const obj = (params ?? {}) as Record<string, unknown>
  for (const key of required) {
    if (!(key in obj)) {
      throw rpcError(RpcErrorCode.InvalidParams, `Missing param: ${String(key)}`)
    }
  }
  return obj as T
}

class UnsupportedCapabilityRpc extends Error {
  constructor(public readonly capability: string) {
    super(`Unsupported capability: ${capability}`)
    this.name = 'UnsupportedCapabilityError'
  }
}

function rpcError(code: number, message: string): RpcError {
  return { code, message }
}

function notImplemented(method: string): never {
  throw new Error(`Host advertises capability but does not implement: ${method}`)
}