// TODO: this entire file is sus, we probably shouldn't have ever had it. Consider refactoring to get rid of it 
import { resolve as resolvePath } from 'path'

import * as fs from '../../utils/fs.js'

import type * as rpc from './rpc.js'
import { PROTOCOL_VERSION, RpcErrorCode, errorToRpc } from './rpc.js'
import type { SubscriptionRegistry, WaitLogSubscriptionRegistry } from './subscriptions.js'
import { type StreamRegistry, type OpenStream, makeStreamEndBridge } from './streams.js'
import { encodeStreamChunk, encodeRpc, hexToBytes, newStreamId, streamIdHex } from './codec.js'
import { event as buildEvent, notification, type RpcEventName, type RpcEventMap } from './rpc.js'
import { Capability, capabilitiesToRecord } from '../../hosts/types.js'
import type { HostLogHandler, HostLogLine, HostProvider } from '../../hosts/types.js'
import type { ActiveConfig } from './active-config.js'
import { setExpectedShutdown } from './daemon.js'
import { UnsupportedCapabilityRpc, rpcError } from './host-capability.js'
import { WsData } from './server.js'
import { type LogMatcher, type LogPattern } from './wait-log.js'
import type { SandstoneConfig } from 'sandstone'
import { add } from 'src/utils/index.js'

/**
 * Thrown by `dispatch` when the caller asked for shutdown.
 */
export class ShutdownSignal extends Error {
  constructor() {
    super('shutdown requested')
    this.name = 'ShutdownSignal'
  }
}

export class RpcHandlerError extends Error {
  constructor(public readonly rpc: rpc.RpcError) {
    super(rpc.message)
    this.name = 'RpcHandlerError'
  }
}

const MAX_DIR_ENTRIES_DEFAULT = 1000

export class DispatcherContext {
  constructor(
    public readonly host: HostProvider,
    public readonly subscriptions: SubscriptionRegistry,
    public readonly waitLogSubscriptions: WaitLogSubscriptionRegistry,
    public readonly logMatcher: LogMatcher,
    public readonly ws: Bun.ServerWebSocket<WsData>,
    public readonly pushLog: (lines: HostLogLine[], subscriptionId: string) => void,
    public readonly startedAt: number,
    public readonly getActiveConfig: () => ActiveConfig | undefined,
    public readonly streams: StreamRegistry,
    public readonly broadcast?: <K extends RpcEventName>(eventName: K, data: RpcEventMap[K]) => void,
    public readonly notifyResourceUpdated?: (uri: string) => void,
    public readonly setActiveConfig?: (cfg: ActiveConfig) => void,
    public readonly getRebuildState?: () => rpc.RebuildState | undefined,
    public readonly setRebuildState?: (state: rpc.RebuildState) => void,
    public readonly setTestState?: (state: rpc.TestState) => void,
    public readonly getTestState?: () => rpc.TestState | undefined,
    public readonly getWatcherStatus?: () => rpc.WatcherStatus | null,
    public readonly setWatcherStatus?: (status: rpc.WatcherStatus, ws: Bun.ServerWebSocket<WsData> | undefined) => void,
    public readonly getExpectedShutdown?: () => boolean,
    public readonly getFullConfig?: () => SandstoneConfig | undefined,
    public readonly appendLogLines?: (entries: rpc.LogLineEntry[], target: 'build' | 'test' | 'server') => void,
    public readonly readLogBuffer?: (target: 'build' | 'test' | 'server', opts?: {
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
    },
  ) {}

}

export class DispatcherInternals {
  readonly context: DispatcherContext

  constructor(public readonly dispatcher: Dispatcher, context: DispatcherContext) {
    this.context = context
  }

  get host() { return this.context.host }
  get subscriptions() { return this.context.subscriptions }
  get ws() { return this.context.ws }
  get pushLog() { return this.context.pushLog }
  get startedAt() { return this.context.startedAt }
  get activeConfig() { return this.context.getActiveConfig() }
  get broadcast() { return this.context.broadcast }
  get notifyResourceUpdated() { return this.context.notifyResourceUpdated }
  get setActiveConfig() { return this.context.setActiveConfig }
  get getRebuildState() { return this.context.getRebuildState }
  get setRebuildState() { return this.context.setRebuildState }
  get setTestState() { return this.context.setTestState }
  get getTestState() { return this.context.getTestState }
  get getWatcherStatus() { return this.context.getWatcherStatus }
  get setWatcherStatus() { return this.context.setWatcherStatus }
  get getExpectedShutdown() { return this.context.getExpectedShutdown }
  get fullConfig() { return this.context.getFullConfig?.() }
  get waitLogSubscriptions() { return this.context.waitLogSubscriptions }
  get logMatcher() { return this.context.logMatcher }
  get appendLogLines() { return this.context.appendLogLines }
  get readLogBuffer() { return this.context.readLogBuffer }
  get streams() { return this.context.streams }

  async requireActiveConfig(): Promise<ActiveConfig> {
    if (!this.activeConfig) {
      throw rpcError(
        RpcErrorCode.NotConnected,
        'No active `sandstone.config.ts`. Run `sand connect` from a Sandstone project, or start `sand watch` to publish one.',
      )
    }
    return this.activeConfig
  }

  parseParams<T extends object>(params: unknown, required: Array<keyof T>): T {
    const obj = (params ?? {}) as Record<string, unknown>
    for (const key of required) {
      if (!(key in obj)) {
        throw rpcError(RpcErrorCode.InvalidParams, `Missing param: ${String(key)}`)
      }
    }
    return obj as T
  }

  async readBufferLog(
    params: rpc.ReadBuildLogParams | undefined,
    target: 'build' | 'test' | 'server',
  ): Promise<rpc.ReadBuildLogResult | rpc.ReadBuildLogResult | rpc.ReadBuildLogResult> {
    const { tail, maxLines, range, since, until } = this.parseParams<rpc.ReadBuildLogParams>(
      params,
      ['tail', 'maxLines', 'range', 'since', 'until'],
    )
    if (!this.readLogBuffer) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon has no log buffer configured')
    }
    const buf = this.readLogBuffer(target, { tail, maxLines, range, since, until })
    const cfg = await this.requireActiveConfig()
    const path = target === 'build' ? cfg.logPath : target === 'test' ? '<test-runner-buffer>' : '<host-stdout-buffer>'
    return {
      path,
      lines: buf.lines,
      totalLines: buf.totalLines,
      matchedLines: buf.matchedLines,
      oldestTs: buf.oldestTs,
      newestTs: buf.newestTs,
      truncated: buf.truncated,
    }
  }

  async readLogFile(path: string): Promise<string[]> {
    try {
      const text = await fs.readText(path)
      const lines = text.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      return lines
    } catch (err) {
      // Re-throw with the file path for diagnosability.
      throw new Error(
        `Failed to read log at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async listDirectory(
    baseDir: string,
    subpath: string,
    limit: number,
  ): Promise<rpc.GetBuildOutputTreeResult> {
    const target = resolvePath(baseDir, subpath)
    if (!(await fs.pathExists(target))) {
      return { baseDir, entries: [], truncated: false }
    }
    const cap = Math.max(1, limit ?? MAX_DIR_ENTRIES_DEFAULT)
    const dirents = await fs.readDirEntries(target)
    const truncated = dirents.length > cap
    const entries: rpc.BuildOutputEntry[] = dirents.slice(0, cap).map((d) => ({
      path: d.name,
      isDirectory: d.isDirectory,
    }))
    return { baseDir, entries, truncated }
  }

  /**
   * Pump `stream` into WS chunks tagged with `streamId`, updating
   * `record.bytes`. Calls `streams.close(...)` on completion so the
   * `streamEnd`/`streamError` notification fires back to the client.
   *
   * Fire-and-forget. Run after the RPC response carrying the streamId
   * has already been sent. Pumping in-line races the response on the
   * wire and orphans the early chunks on the client, whose
   * `streamsById` only populates after parsing the response.
   */
  async pumpReadStream(
    stream: ReadableStream<Uint8Array>,
    streamId: string,
    record: OpenStream,
  ): Promise<void> {
    const reader = stream.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        record.bytes += value.byteLength
        try {
          this.context.ws.send(encodeStreamChunk(hexToBytes(streamId), value))
        } catch {
          /* disconnected — close path below will fan the error out */
        }
      }
      this.context.streams.close(streamId, record.bytes)
    } catch (err) {
      this.context.streams.close(
        streamId,
        record.bytes,
        err instanceof Error ? err : new Error(String(err)),
      )
    }
  }
}

export class Dispatcher {
  protected readonly internals: DispatcherInternals

  constructor(ctx: DispatcherContext) {
    const context = new DispatcherContext(
      ctx.host,
      ctx.subscriptions,
      ctx.waitLogSubscriptions,
      ctx.logMatcher,
      ctx.ws,
      ctx.pushLog,
      ctx.startedAt,
      ctx.getActiveConfig ?? (() => undefined),
      ctx.streams,
      ctx.broadcast,
      ctx.notifyResourceUpdated,
      ctx.setActiveConfig,
      ctx.getRebuildState,
      ctx.setRebuildState,
      ctx.setTestState,
      ctx.getTestState,
      ctx.getWatcherStatus,
      ctx.setWatcherStatus,
      ctx.getExpectedShutdown,
      ctx.getFullConfig,
      ctx.appendLogLines,
      ctx.readLogBuffer,
    )
    this.internals = new DispatcherInternals(this, context)
  }

  async ping(_params: undefined): Promise<rpc.PingResult> {
    const caps = capabilitiesToRecord(this.internals.host.capabilities)
    return {
      protocol: PROTOCOL_VERSION,
      hostType: this.internals.host.type,
      displayName: this.internals.host.displayName,
      capabilities: caps,
      pid: process.pid,
      uptimeMs: Date.now() - this.internals.startedAt,
    }
  }

  async startServer(_params: undefined): Promise<void> {
    const host = this.internals.host
    if (!host.startServer) throw new UnsupportedCapabilityRpc(Capability.StartServer)
    await host.startServer()
  }

  async stopServer(_params?: undefined): Promise<void> {
    // Graceful stop timeout is host-configured (`gracefulStopTimeoutSeconds`).
    // See `integrated.stopServer` and `ssh.stopServer` for the per-host
    // graceful-then-forceful logic.
    setExpectedShutdown(true)
    const host = this.internals.host
    if (!host.stopServer) throw new UnsupportedCapabilityRpc(Capability.StopServer)
    await host.stopServer()
  }

  async readFile(params: rpc.ReadFileParams): Promise<rpc.RpcReadFileStream> {
    const ctx = this.internals
    const host = this.internals.host
    if (!host.readFileStream) throw new UnsupportedCapabilityRpc('readFileStream')
    const streamInfo = await host.readFileStream(params.path)
    const streamId = streamIdHex(newStreamId())
    const record = ctx.streams.open({
      streamId,
      direction: 'incoming',
      kind: 'readFile',
      onClose: makeStreamEndBridge(ctx.ws, streamId),
    })
    // Fire-and-forget. See `pumpReadStream` for the ordering rationale.
    // Errors surface through `streams.close`.
    this.internals.pumpReadStream(streamInfo.stream, streamId, record)
    return { streamId, totalSize: streamInfo.size }
  }

  async writeFile(params: rpc.WriteFileParams): Promise<rpc.WriteFileResult> {
    const ctx = this.internals
    const host = this.internals.host
    if (!host.writeFileStream) throw new UnsupportedCapabilityRpc('writeFileStream')
    const sink: WritableStream<Uint8Array> = await host.writeFileStream(params.path, params.size !== undefined ? { size: params.size } : undefined)
    const streamId = streamIdHex(newStreamId())
    const ws = ctx.ws as { send(data: Uint8Array): void } | undefined
    ctx.streams.open({
      streamId,
      direction: 'incoming',
      kind: 'writeFile',
      onClose: makeStreamEndBridge(ws, streamId),
    })
    ctx.streams.attachWriter(streamId, sink.getWriter())
    return { streamId }
  }

  async streamEnd(params: { streamId: string; bytes?: number }): Promise<void> {
    const ctx = this.internals
    const finalBytes = ctx.streams.get(params.streamId)!.bytes!
    if (params.bytes !== undefined && finalBytes !== params.bytes) {
      throw rpcError(
        RpcErrorCode.InternalError,
        `streamEnd byte count mismatch for ${params.streamId}: server tracked ${finalBytes}, client claimed ${params.bytes}`,
      )
    }
    ctx.streams.close(params.streamId, finalBytes)
  }

  async executeRawCommand(params: rpc.ExecuteRawCommandParams): Promise<rpc.ExecuteRawCommandResult> {
    if (params.command.trim().toLowerCase() === 'stop') {
      setExpectedShutdown(true)
    }
    const host = this.internals.host
    if (!host.executeRawCommand) throw new UnsupportedCapabilityRpc(Capability.ExecuteRawCommand)

    // Register the matcher BEFORE the command so a line the command
    // emits is captured (and so we don't race the command's dispatch).
    // Promise + cancel ride along on the result so the caller can await
    // the line or abandon the wait.
    let matcherHandle: { promises: Promise<string[]>[], patternUUIDs: string[], interrupt(): Promise<void> } | null = null
    if (params.waitFor) {
      matcherHandle = await this.internals.logMatcher.waitForLog([params.waitFor])
    }

    const output = (await host.executeRawCommand(params.command)) ?? ''

    const result: rpc.ExecuteRawCommandResult = { output }
    if (matcherHandle) {
      result.logResult = matcherHandle.promises[0]
      result.cancel = () => matcherHandle!.interrupt()
      result.patternUUID = matcherHandle.patternUUIDs[0]
    }
    return result
  }

  async reloadResources(_params: undefined): Promise<void> {
    const packName = this.internals.fullConfig?.name
    const prefix = packName ? `[Sandstone @ ${packName}]` : '[Sandstone]'
    const startingLine = `${prefix} Reload Starting...`
    const finishedLine = `${prefix} Reload Finished!`

    const { logResult: started } = await this.executeRawCommand({
      command: `say ${startingLine}`,
      waitFor: { kind: 'endsWith', value: startingLine, timeoutMs: 10000 }
    })
    await started

    await this.executeRawCommand({ command: 'reload' })

    const { logResult: finished } = await this.executeRawCommand({
      command: `say ${finishedLine}`,
      waitFor: { kind: 'endsWith', value: finishedLine, timeoutMs: 1000 * 60 * 8 }
    })
    await finished
  }

  async attachLog(params: rpc.AttachLogParams | undefined): Promise<rpc.AttachLogResult> {
    const filter = params?.regex ? new RegExp(params.regex) : null
    const ctx = this.internals

    const subscriptionId = ctx.subscriptions.registerWithId(crypto.randomUUID(), ctx.ws)

    const handler: HostLogHandler = (lines) => {
      if (filter) {
        const matched = lines.filter((l) => filter.test(l.line))
        if (matched.length > 0) ctx.pushLog(matched, subscriptionId)
      } else {
        ctx.pushLog(lines, subscriptionId)
      }
    }
    const host = this.internals.host
    if (!host.attachLog) throw new UnsupportedCapabilityRpc('attachLog')
    const subscription = await host.attachLog(handler)
    ctx.subscriptions.setUnattach(subscriptionId, () => subscription.unattach())
    return { subscriptionId }
  }

  async waitForLog(params: rpc.WaitForLogParams): Promise<rpc.WaitForLogResult> {
    const host = this.internals.host
    if (!host.attachLog) throw new UnsupportedCapabilityRpc('attachLog')

    const subscriptionId = this.internals.waitLogSubscriptions.generateId()
    const ws = this.internals.ws

    const handle = await this.internals.logMatcher.waitForLog(params.patterns as LogPattern[])

    handle.subscribe((entry) => {
      if (entry.status === 'interrupted') return
      const at = new Date().toISOString()
      const base = { subscriptionId, patternUUID: entry.patternUUID, patternIndex: entry.patternIndex, at }
      const event: rpc.WaitForLogEvent = entry.status === 'matched'
        ? { ...base, status: 'matched', lines: entry.lines }
        : { ...base, status: 'timed_out', timeoutMs: entry.timeoutMs! }
      try {
        ws.send(encodeRpc(notification('waitForLog', event)))
      } catch {}
    })

    this.internals.waitLogSubscriptions.register(subscriptionId, ws, handle)
    return { subscriptionId, patternUUIDs: handle.patternUUIDs }
  }

  async unwaitForLog(params: rpc.UnwaitForLogParams): Promise<void> {
    const handle = this.internals.waitLogSubscriptions.drop(params.subscriptionId)
    if (!handle) throw rpcError(RpcErrorCode.UnknownSubscription, `Unknown waitForLog subscription: ${params.subscriptionId}`)
    await handle.interrupt()
  }

  async unattach(params: rpc.UnattachParams): Promise<void> {
    const ok = await this.internals.subscriptions.unattach(params.subscriptionId)
    if (!ok) throw rpcError(RpcErrorCode.UnknownSubscription, `Unknown subscription: ${params.subscriptionId}`)
  }

  async getActiveConfig(_params: undefined): Promise<rpc.GetActiveConfigResult> {
    const cfg = await this.internals.requireActiveConfig()
    const clientPath = cfg.saveConfig?.clientPath
    return {
      mode: cfg.mode,
      configPath: cfg.configPath,
      saveConfig: cfg.saveConfig,
      clientLogAvailable: typeof clientPath === 'string' && clientPath.length > 0,
      outputDir: cfg.outputDir,
      projectRoot: cfg.projectRoot,
      loadedAt: cfg.loadedAt,
    }
  }

  async getBuildOutputTree(params: rpc.GetBuildOutputTreeParams | undefined): Promise<rpc.GetBuildOutputTreeResult> {
    const cfg = await this.internals.requireActiveConfig()
    const subpath = params?.path ?? ''
    const limit = params?.limit ?? 1000
    return this.internals.listDirectory(cfg.outputDir, subpath, limit)
  }

  async readBuildLog(params: rpc.ReadBuildLogParams | undefined): Promise<rpc.ReadBuildLogResult> {
    return this.internals.readBufferLog(params, 'build') as Promise<rpc.ReadBuildLogResult>
  }

  async readTestLog(params: rpc.ReadBuildLogParams | undefined): Promise<rpc.ReadBuildLogResult> {
    return this.internals.readBufferLog(params, 'test') as Promise<rpc.ReadBuildLogResult>
  }

  async readServerLog(params: rpc.ReadServerLogParams | undefined): Promise<rpc.ReadBuildLogResult> {
    return this.internals.readBufferLog(params, 'server') as Promise<rpc.ReadBuildLogResult>
  }

  // TODO: Implement an actual tail and buffer for this.
  async readClientLog(params: rpc.ReadClientLogParams | undefined): Promise<rpc.ReadClientLogResult> {
    const cfg = await this.internals.requireActiveConfig()
    const clientPath = cfg.saveConfig?.clientPath
    if (!clientPath) {
      throw rpcError(
        RpcErrorCode.InvalidParams,
        'No `saveConfig.clientPath` configured in sandstone.config.ts',
      )
    }
    const tail = params?.tail ?? null
    const maxLines = params?.maxLines ?? null
    const range = params?.range ?? null
    const logPath = `${clientPath}/logs/latest.log`
    const lines = await this.internals.readLogFile(logPath)
    const totalLines = lines.length

    // Range filter: `0` = most recent line in the file. Negative
    // counts from the end.
    let selected = lines
    if (range && range.from !== -1 && range.to !== -1) {
      const len = selected.length
      const startIdx = len - 1 - Math.min(range.from, len - 1)
      const endIdx = len - 1 - Math.min(range.to, len - 1)
      const lo = Math.max(0, Math.min(startIdx, endIdx))
      const hi = Math.min(len - 1, Math.max(startIdx, endIdx))
      selected = selected.slice(lo, hi + 1)
    }
    const matchedLines = selected.length

    // Tail / maxLines cap the final slice.
    const want = tail ?? maxLines ?? 200
    const truncated = selected.length > want
    const finalLines = truncated ? selected.slice(-want) : selected

    return {
      path: logPath,
      lines: finalLines,
      totalLines,
      matchedLines,
      truncated,
    }
  }

  async publishConfig(params: rpc.PublishConfigParams) {
    const ctx = this.internals
    if (!ctx.setActiveConfig) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to accept published configs')
    }
    if (!ctx.broadcast) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast events')
    }
    const next: ActiveConfig = {
      mode: params.mode,
      configPath: params.configPath,
      saveConfig: params.saveConfig,
      outputDir: params.outputDir,
      logPath: `${params.projectRoot}/.sandstone/watch.log`,
      projectRoot: params.projectRoot,
      loadedAt: params.loadedAt,
    }
    ctx.setActiveConfig(next)
    ctx.broadcast('configChanged', {
      saveConfig: next.saveConfig,
      mode: next.mode,
      configPath: next.configPath,
      detectedAt: new Date().toISOString(),
    })
  }

  async publishLog(params: rpc.PublishLogParams) {
    const ctx = this.internals
    if (!ctx.appendLogLines) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to accept log lines')
    }
    ctx.appendLogLines(params.entries, params.target ?? 'build')
  }

  async publishRebuild(params: rpc.PublishRebuildParams) {
    const ctx = this.internals
    if (!ctx.setRebuildState) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to track rebuild state')
    }
    if (!ctx.notifyResourceUpdated) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast resource notifications')
    }
    const state: rpc.RebuildState = {
      state: params.state,
      fileCount: params.fileCount,
      errorCount: params.errorCount,
      warningCount: params.warningCount,
      at: params.at,
      ...add({ message: params.message }),
    }
    ctx.setRebuildState(state)
    ctx.notifyResourceUpdated('sandstone://rebuild-state')
  }

  async getRebuildState(_params: undefined): Promise<rpc.GetRebuildStateResult> {
    const ctx = this.internals
    if (!ctx.getRebuildState) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to expose rebuild state')
    }
    return { state: ctx.getRebuildState() ?? null }
  }

  async publishTestComplete(params: rpc.TestState) {
    const ctx = this.internals
    if (!ctx.setTestState) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to track test state')
    }
    if (!ctx.notifyResourceUpdated) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast resource notifications')
    }
    const state: rpc.TestState = {
      state: params.state,
      pass: params.pass,
      fail: params.fail,
      durationSec: params.durationSec,
      at: params.at ?? new Date().toISOString(),
      ...(params.message !== undefined ? { message: params.message } : {}),
    }
    ctx.setTestState(state)
    ctx.notifyResourceUpdated('sandstone://test-state')
  }

  async getTestState(_params: undefined): Promise<rpc.GetTestStateResult> {
    const ctx = this.internals
    if (!ctx.getTestState) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to expose test state')
    }
    return { state: ctx.getTestState() ?? null }
  }

  async publishWatcherStatus(params: rpc.PublishWatcherStatusParams) {
    const ctx = this.internals
    if (!ctx.setWatcherStatus) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to track watcher status')
    }
    if (!ctx.notifyResourceUpdated) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast resource notifications')
    }
    ctx.setWatcherStatus({
      connected: params.connected,
      mode: params.mode,
      manual: params.manual,
      testingMode: params.testingMode,
      path: params.path,
      pid: params.pid,
      at: params.at ?? new Date().toISOString(),
    }, ctx.ws)
    ctx.notifyResourceUpdated('sandstone://watcher-status')
  }

  async getWatcherStatus(_params: undefined): Promise<rpc.GetWatcherStatusResult> {
    const ctx = this.internals
    if (!ctx.getWatcherStatus) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to expose watcher status')
    }
    const status = ctx.getWatcherStatus()
    return { status: status ?? null }
  }

  async publishTriggerBuild(_params: undefined): Promise<rpc.PublishTriggerBuildResult> {
    const ctx = this.internals
    if (!ctx.broadcast) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast events')
    }
    ctx.broadcast('triggerBuild', { at: new Date().toISOString() })
    return { triggered: true }
  }

  async cancelTriggerBuild(_params: undefined): Promise<rpc.CancelTriggerBuildResult> {
    const ctx = this.internals
    if (!ctx.broadcast) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast events')
    }
    ctx.broadcast('cancelTriggerBuild', { at: new Date().toISOString() })
    return { cancelled: true }
  }

  async setBuildMode(params: rpc.SetBuildModeParams): Promise<rpc.SetBuildModeResult> {
    const ctx = this.internals
    if (!ctx.broadcast) {
      throw rpcError(RpcErrorCode.InternalError, 'Daemon is not configured to broadcast events')
    }
    ctx.broadcast('setBuildMode', { mode: params.mode, at: new Date().toISOString() })
    return { applied: true }
  }
}

const RPC_METHODS = new Set(Object.getOwnPropertyNames(Dispatcher.prototype))
RPC_METHODS.delete('constructor')

const KNOWN_METHODS: ReadonlySet<keyof Dispatcher | 'shutdown'> = new Set([
  ...RPC_METHODS,
  'shutdown',
] as Array<keyof Dispatcher | 'shutdown'>)

export function narrowMethod(method: string): rpc.RpcMethod {
  if (!KNOWN_METHODS.has(method as keyof Dispatcher | 'shutdown')) {
    throw rpcError(RpcErrorCode.MethodNotFound, `Unknown method: ${method}`)
  }
  return method as rpc.RpcMethod
}

export async function dispatch<Method extends rpc.RpcMethod>(
  dispatcher: Dispatcher,
  method: Method,
  params: Parameters<Dispatcher[Extract<Method, keyof Dispatcher>]>[0],
) {
  if (method === 'shutdown') throw new ShutdownSignal()
  try {
    type TypedHandler = {
      [M in Extract<Method, keyof Dispatcher>]: (
        p: Parameters<Dispatcher[M]>[0],
      ) => ReturnType<Dispatcher[M]>
    }
    return await (dispatcher as unknown as TypedHandler)[method as Extract<Method, keyof Dispatcher>](params)
  } catch (e) {
    if (e instanceof ShutdownSignal) throw e
    throw new RpcHandlerError(errorToRpc(e))
  }
}

