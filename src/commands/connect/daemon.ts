import { resolve as resolvePath } from 'path'
import chalk from 'chalk-template'

import * as fs from '../../utils/fs.js'
import * as rpc from './rpc.js'
import {
  PROTOCOL_VERSION,
  RpcErrorCode,
  event as buildEvent,
  notification,
  classifyWsMessage,
  type RpcEventMap,
  type RpcEventName,
  type RpcMethod,
  type RpcMethodParams,
  type RpcResult,
} from './rpc.js'
import { WaitLogSubscriptionRegistry } from './wait-log.js'
import { StreamRegistry, type OpenStream, makeStreamEndBridge } from './streams.js'
import { encodeRpc, encodeStreamChunk, newStreamId, streamIdHex, hexToBytes, decodeStreamChunk, STREAM_MAGIC } from './codec.js'
import { LogMatcher, type LogPattern } from './wait-log.js'
import { Capability, capabilitiesToRecord, type HostLogHandler, type HostLogLine, type HostProvider } from '../../hosts/types.js'
import { loadActiveConfigFromDisk, type ActiveConfig } from './active-config.js'
import type { SandstoneConfig } from 'sandstone'
import { add } from 'src/utils/index.js'
import { deleteEndpoint, endpointStatus, generateSecret, writeEndpoint, type EndpointFile } from './endpoint-file.js'
import { NULL_LOGGER, type DaemonLogger } from './logger.js'

const MAX_PAYLOAD = 128 * 1024 * 1024
const MAX_DIR_ENTRIES_DEFAULT = 1000
const LOG_MAX_BATCH = 64
const LOG_FLUSH_MS = 50
const SHUTDOWN_BROADCAST_DELAY_MS = 100

export interface WsData {
  secret: string
}

type SessionWebSocket = Bun.ServerWebSocket<WsData>

interface SessionContext {
  attachSub: { subscriptionId: string; unattach: () => Promise<void> } | null
  pendingBySub: Map<string, rpc.LogLineEntry[]>
  flushTimerBySub: Map<string, ReturnType<typeof setTimeout>>
  shuttingDown: boolean
}

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

function rpcError(code: number, message: string): RpcHandlerError {
  return new RpcHandlerError({ code, message })
}

function unsupportedCap(cap: Capability | string): RpcHandlerError {
  return rpcError(RpcErrorCode.MethodNotFound, `Host does not support ${cap}`)
}

export interface DaemonHandle {
  daemon: Daemon
  url: string
  port: number
  endpoint: EndpointFile
  done: Promise<void>
  shutdown(): Promise<void>
  broadcast<K extends RpcEventName>(eventName: K, data: RpcEventMap[K]): void
  notifyResourceUpdated(uri: string): void
}

export class Daemon {
  readonly host: HostProvider
  readonly logger: DaemonLogger
  private readonly waitLogSubs = new WaitLogSubscriptionRegistry()
  private readonly streams = new StreamRegistry()
  private readonly logMatcher: LogMatcher
  private readonly startedAt = Date.now()

  // ---- Runtime state (persists across RPC calls) ----
  private activeConfig: ActiveConfig | undefined
  private rebuildState: rpc.RebuildState | undefined
  private testState: rpc.TestState | undefined
  private watcherStatus: rpc.WatcherStatus | null = null
  private fullConfig: SandstoneConfig | undefined

  // ---- Lifecycle flags ----
  private expectedShutdown = false
  private shuttingDown = false

  // ---- In-memory log buffers (hosted mode only) ----
  private buildBuffer: rpc.LogLineEntry[] = []
  private testBuffer: rpc.LogLineEntry[] = []
  private serverBuffer: rpc.LogLineEntry[] = []
  private pushToLog: (target: 'build' | 'test' | 'server') => (entries: rpc.LogLineEntry[]) => void

  // ---- Client log tail state (system `tail` / PowerShell follower) ----
  private clientLogPath: string | null = null
  private clientLogBuffer: rpc.LogLineEntry[] = []
  private clientLogPartial = ''
  private clientLogSub: { proc: Bun.Subprocess, cancel: () => void } | null = null

  // ---- Hosted-mode WS state ----
  private wsServer: ReturnType<typeof Bun.serve> | null = null
  private wsUrl = ''
  private endpointFile: EndpointFile | null = null
  private sessions = new Map<SessionWebSocket, SessionContext>()

  // ---- Direct-mode attachLog subscriptions (no WS to push to). ----
  private directSubscriptions = new Map<string, {
    subscriptionId: string,
    onLines(fn: (lines: HostLogLine[]) => void): void,
    unattach(): Promise<void>,
  }>()
  private resolveDone: (() => void) | null = null
  private donePromise: Promise<void>

  /** Hosted mode: bootstrap WS server, write endpoint file, install signal handlers. */
  static async connect(opts: {
    host: HostProvider
    bind?: string
    port?: number
    projectRoot: string
    fullConfig?: SandstoneConfig
    logger?: DaemonLogger
    onShutdown?: () => Promise<void> | void
  }): Promise<DaemonHandle> {
    const daemon = new Daemon(opts.host, opts.fullConfig, opts.logger)
    const handle = await daemon.enableWsServer(opts)
    daemon.logger.info(chalk`{cyan [connect]} listening on {bold ${handle.url}} (pid ${handle.endpoint.pid})`)
    daemon.logger.info(chalk`{cyan [connect]} endpoint file: ${opts.projectRoot + '/.sandstone/connect.url'}`)
    return handle
  }

  /** Direct mode: no WS server, no signal handlers, no endpoint file. Methods
   *  are called directly on the daemon. Caller owns host lifecycle. */
  static forDirect(host: HostProvider, opts?: { logger?: DaemonLogger }): Daemon {
    return new Daemon(host, undefined, opts?.logger)
  }

  constructor(host: HostProvider, fullConfig?: SandstoneConfig, logger: DaemonLogger = NULL_LOGGER) {
    this.host = host
    this.logger = logger
    this.fullConfig = fullConfig
    this.logMatcher = new LogMatcher((handler) => this.callHostAttachLog(handler))
    this.donePromise = new Promise<void>((r) => { this.resolveDone = r })
    const build = (target: 'build' | 'test' | 'server') => (entries: rpc.LogLineEntry[]) => {
      const buf = target === 'build' ? this.buildBuffer : target === 'test' ? this.testBuffer : this.serverBuffer
      buf.push(...entries)
    }
    this.pushToLog = build
  }

  private async callHostAttachLog(handler: HostLogHandler) {
    if (!this.host.attachLog) throw new Error('Host does not support attachLog')
    return await this.host.attachLog(handler)
  }

  async ping(): Promise<rpc.PingResult> {
    const caps = capabilitiesToRecord(this.host.capabilities)
    return {
      protocol: PROTOCOL_VERSION,
      hostType: this.host.type,
      displayName: this.host.displayName,
      capabilities: caps,
      pid: process.pid,
      uptimeMs: Date.now() - this.startedAt,
    }
  }

  async startServer(): Promise<void> {
    if (!this.host.startServer) throw unsupportedCap(Capability.StartServer)
    await this.host.startServer()
  }

  async stopServer(): Promise<void> {
    this.expectedShutdown = true
    if (!this.host.stopServer) throw unsupportedCap(Capability.StopServer)
    await this.host.stopServer()
  }

  async readFile(path: string, opts?: { encode?: 'utf-8' }): Promise<Uint8Array | string> {
    if (!this.host.readFile) throw unsupportedCap('readFile')
    const buf = await this.host.readFile(path)
    return opts?.encode === 'utf-8' ? new TextDecoder('utf-8').decode(buf) : buf
  }

  async readFileStream(path: string): Promise<{ streamId: string; stream: ReadableStream<Uint8Array>; totalSize?: number; done: Promise<{ bytesRead: number }> }> {
    if (!this.host.readFileStream) throw unsupportedCap('readFileStream')
    const info = await this.host.readFileStream(path)
    const streamId = streamIdHex(newStreamId())
    const record = this.streams.open({
      streamId,
      direction: 'incoming',
      kind: 'readFile',
    })
    this.pumpReadStream(info.stream, streamId, record).catch(() => {})
    return {
      streamId,
      stream: info.stream,
      totalSize: info.size,
      done: new Promise<{ bytesRead: number }>((resolve) => {
        const check = setInterval(() => {
          if (record.bytes !== undefined) {
            clearInterval(check)
            resolve({ bytesRead: record.bytes })
          }
        }, 5)
      }),
    }
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<{ bytesWritten: number }> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const CHUNK = 64 * 1024 * 1024
        for (let off = 0; off < bytes.byteLength; off += CHUNK) {
          controller.enqueue(bytes.subarray(off, Math.min(off + CHUNK, bytes.byteLength)))
        }
        controller.close()
      },
    })
    const result = await this.writeFileStream({ path, stream, size: bytes.byteLength })
    return { bytesWritten: (await result.done).bytesWritten }
  }

  async writeFileStream(params: {
    path: string,
    stream: ReadableStream<Uint8Array>,
    size?: number,
  }): Promise<{ streamId: string, done: Promise<{ bytesWritten: number }> }> {
    if (!this.host.writeFileStream) throw unsupportedCap('writeFileStream')
    const sink: WritableStream<Uint8Array> = await this.host.writeFileStream(
      params.path,
      params.size !== undefined ? { size: params.size } : undefined,
    )
    const streamId = streamIdHex(newStreamId())
    this.streams.open({
      streamId,
      direction: 'incoming',
      kind: 'writeFile',
    })
    this.streams.attachWriter(streamId, sink.getWriter())
    return {
      streamId,
      done: new Promise<{ bytesWritten: number }>((resolve) => {
        const check = setInterval(() => {
          if (this.streams.get(streamId)?.bytes !== undefined) {
            clearInterval(check)
            resolve({ bytesWritten: this.streams.get(streamId)!.bytes! })
          }
        }, 5)
      }),
    }
  }

  async streamEnd(params: rpc.StreamEndParams): Promise<void> {
    const record = this.streams.get(params.streamId)
    if (!record) throw rpcError(RpcErrorCode.UnknownSubscription, `Unknown stream: ${params.streamId}`)
    const finalBytes = record.bytes ?? 0
    if (params.bytes !== undefined && finalBytes !== params.bytes) {
      throw rpcError(
        RpcErrorCode.InternalError,
        `streamEnd byte count mismatch for ${params.streamId}: server tracked ${finalBytes}, client claimed ${params.bytes}`,
      )
    }
    this.streams.close(params.streamId, finalBytes)
  }

  async executeRawCommand(params: rpc.ExecuteRawCommandParams): Promise<rpc.ExecuteRawCommandResult> {
    if (params.command.trim().toLowerCase() === 'stop') {
      this.expectedShutdown = true
    }
    if (!this.host.executeRawCommand) throw unsupportedCap(Capability.ExecuteRawCommand)

    let matcherHandle: Awaited<ReturnType<typeof this.logMatcher.waitForLog>> | null = null
    if (params.waitFor) {
      matcherHandle = await this.logMatcher.waitForLog([params.waitFor])
    }

    const output = (await this.host.executeRawCommand(params.command)) ?? ''

    const result: rpc.ExecuteRawCommandResult = { output }
    if (matcherHandle) {
      result.logResult = matcherHandle.promises[0]
      result.cancel = () => matcherHandle!.interrupt()
      result.patternUUID = matcherHandle.patternUUIDs[0]
    }
    return result
  }

  async reloadResources(): Promise<void> {
    const packName = this.fullConfig?.name
    const prefix = packName ? `[Sandstone @ ${packName}]` : '[Sandstone]'
    const startingLine = `${prefix} Reload Starting...`
    const finishedLine = `${prefix} Reload Finished!`

    const { logResult: started } = await this.executeRawCommand({
      command: `say ${startingLine}`,
      waitFor: { kind: 'endsWith', value: startingLine, timeoutMs: 10_000 },
    })
    await started

    await this.executeRawCommand({ command: 'reload' })

    const { logResult: finished } = await this.executeRawCommand({
      command: `say ${finishedLine}`,
      waitFor: { kind: 'endsWith', value: finishedLine, timeoutMs: 1_000 * 60 * 8 },
    })
    await finished
  }

  async attachLog(params?: rpc.AttachLogParams | { regex?: string }): Promise<{
    subscriptionId: string,
    onLines(fn: (lines: HostLogLine[]) => void): void,
    unattach(): Promise<void>,
  }> {
    if (!this.host.attachLog) throw unsupportedCap(Capability.AttachLog)
    const filter = params?.regex ? new RegExp(params.regex) : null
    const subscriptionId = crypto.randomUUID()
    const listeners = new Set<(lines: HostLogLine[]) => void>()

    const handler: HostLogHandler = (lines) => {
      const matched = filter ? lines.filter((l) => filter.test(l.line)) : lines
      if (matched.length === 0) return
      for (const l of listeners) l(matched)
      for (const [ws, session] of this.sessions) {
        if (session.attachSub?.subscriptionId !== subscriptionId) continue
        const buf = session.pendingBySub.get(subscriptionId) ?? []
        buf.push(...matched)
        session.pendingBySub.set(subscriptionId, buf)
        if (!session.flushTimerBySub.has(subscriptionId)) {
          session.flushTimerBySub.set(subscriptionId, setTimeout(() => {
            session.flushTimerBySub.delete(subscriptionId)
            this.flushLogs(session, ws, subscriptionId)
          }, LOG_FLUSH_MS))
        }
      }
    }
    const hostSub = await this.host.attachLog(handler)

    let detached = false
    const sub = {
      subscriptionId,
      onLines(fn: (lines: HostLogLine[]) => void) { listeners.add(fn) },
      async unattach() {
        if (detached) return
        detached = true
        listeners.clear()
        await hostSub.unattach().catch(() => {})
      },
    }

    this.directSubscriptions.set(subscriptionId, sub)
    return sub
  }

  async waitForLog(params: rpc.WaitForLogParams, session: SessionContext): Promise<rpc.WaitForLogResult> {
    if (!this.host.attachLog) throw unsupportedCap(Capability.AttachLog)
    const subscriptionId = this.waitLogSubs.generateId()
    const handle = await this.logMatcher.waitForLog(params.patterns as LogPattern[])

    handle.subscribe((entry) => {
      if (entry.status === 'interrupted') return
      const at = new Date().toISOString()
      const base = { subscriptionId, patternUUID: entry.patternUUID, patternIndex: entry.patternIndex, at }
      const event: rpc.WaitForLogEvent = entry.status === 'matched'
        ? { ...base, status: 'matched', lines: entry.lines }
        : { ...base, status: 'timed_out', timeoutMs: entry.timeoutMs! }
      const ws = this.findSessionWs(session)
      if (ws) {
        try { ws.send(encodeRpc(notification('waitForLog', event))) } catch {}
      }
    })

    this.waitLogSubs.register(subscriptionId, 'direct', handle)
    return { subscriptionId, patternUUIDs: handle.patternUUIDs }
  }

  async unwaitForLog(params: rpc.UnwaitForLogParams): Promise<void> {
    const handle = this.waitLogSubs.drop(params.subscriptionId)
    if (!handle) throw rpcError(RpcErrorCode.UnknownSubscription, `Unknown waitForLog subscription: ${params.subscriptionId}`)
    await handle.interrupt()
  }

  async unattach(params: rpc.UnattachParams): Promise<void> {
    // Detach the subscription. Looks up in directSubscriptions; the WS
    // layer also pops from there because `attachLog` registers every
    // subscription regardless of mode.
    const sub = this.directSubscriptions.get(params.subscriptionId)
    if (!sub) throw rpcError(RpcErrorCode.UnknownSubscription, `Unknown subscription: ${params.subscriptionId}`)
    this.directSubscriptions.delete(params.subscriptionId)
    await sub.unattach().catch(() => {})
  }

  async getActiveConfig(): Promise<rpc.GetActiveConfigResult> {
    const cfg = await this.requireActiveConfig()
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
    const cfg = await this.requireActiveConfig()
    const subpath = params?.path ?? ''
    const limit = params?.limit ?? MAX_DIR_ENTRIES_DEFAULT
    return this.listDirectory(cfg.outputDir, subpath, limit)
  }

  async readBuildLog(params: rpc.ReadBuildLogParams | undefined): Promise<rpc.ReadBuildLogResult> {
    return this.readBufferLog(params, 'build') as Promise<rpc.ReadBuildLogResult>
  }

  async readTestLog(params: rpc.ReadBuildLogParams | undefined): Promise<rpc.ReadBuildLogResult> {
    return this.readBufferLog(params, 'test') as Promise<rpc.ReadBuildLogResult>
  }

  async readServerLog(params: rpc.ReadServerLogParams | undefined): Promise<rpc.ReadBuildLogResult> {
    return this.readBufferLog(params, 'server') as Promise<rpc.ReadBuildLogResult>
  }

  async readClientLog(params: rpc.ReadClientLogParams | undefined): Promise<rpc.ReadClientLogResult> {
    const cfg = await this.requireActiveConfig()
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
    await this.ensureClientLogTail(logPath)

    const { selected, totalLines, matchedLines, truncated } = this.selectLines<rpc.LogLineEntry>(
      this.clientLogBuffer,
      { tail, maxLines, range },
    )

    return {
      path: logPath,
      lines: selected.map((e) => e.line),
      totalLines,
      matchedLines,
      truncated,
    }
  }

  private async ensureClientLogTail(logPath: string): Promise<void> {
    if (this.clientLogSub !== null && this.clientLogPath === logPath) return
    if (this.clientLogSub !== null) {
      this.clientLogSub.cancel()
      this.clientLogSub = null
    }
    this.clientLogPath = logPath
    this.clientLogBuffer = []
    this.clientLogPartial = ''

    const cmd = process.platform === 'win32'
      ? ['powershell', '-NoProfile', '-Command', `Get-Content -Path '${logPath.replace(/'/g, "''")}' -Tail 0 -Wait`]
      : ['tail', '-F', '-n', '0', logPath]
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    let cancelled = false
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      try { proc.kill() } catch {}
    }
    this.clientLogSub = { proc, cancel }

    const decoder = new TextDecoder('utf-8')
    const handleChunk = (chunk: string) => {
      const combined = this.clientLogPartial + chunk
      const parts = combined.split('\n')
      this.clientLogPartial = parts.pop() ?? ''
      if (parts.length === 0) return
      const now = Date.now()
      for (const line of parts) {
        this.clientLogBuffer.push({ line, ts: now, stream: 'stdout' })
      }
    }

    void (async () => {
      const reader = proc.stdout.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          handleChunk(decoder.decode(value, { stream: true }))
        }
      } catch {}
      finally { reader.releaseLock() }
    })()

    void (async () => {
      const reader = proc.stderr.getReader()
      try { while (true) { const { done } = await reader.read(); if (done) break } }
      catch {}
      finally { reader.releaseLock() }
    })()

    void proc.exited.then(() => {
      if (this.clientLogSub?.proc === proc) this.clientLogSub = null
    })
  }

  private stopClientLogTail(): void {
    this.clientLogSub?.cancel()
    this.clientLogSub = null
  }

  private async startClientLogTailFromConfig(): Promise<void> {
    const clientPath = this.activeConfig?.saveConfig?.clientPath
    if (typeof clientPath !== 'string' || clientPath.length === 0) return
    await this.ensureClientLogTail(`${clientPath}/logs/latest.log`)
  }

  async publishConfig(params: rpc.PublishConfigParams): Promise<void> {
    const next: ActiveConfig = {
      mode: params.mode,
      configPath: params.configPath,
      saveConfig: params.saveConfig,
      outputDir: params.outputDir,
      logPath: `${params.projectRoot}/.sandstone/watch.log`,
      projectRoot: params.projectRoot,
      loadedAt: params.loadedAt,
    }
    this.activeConfig = next
    await this.startClientLogTailFromConfig()
    this.broadcast('configChanged', {
      saveConfig: next.saveConfig,
      mode: next.mode,
      configPath: next.configPath,
      detectedAt: new Date().toISOString(),
    })
  }

  async publishLog(params: rpc.PublishLogParams): Promise<void> {
    this.pushToLog(params.target ?? 'build')(params.entries)
  }

  async publishRebuild(params: rpc.PublishRebuildParams): Promise<void> {
    this.rebuildState = {
      state: params.state,
      fileCount: params.fileCount,
      errorCount: params.errorCount,
      warningCount: params.warningCount,
      at: params.at,
      ...add({ message: params.message }),
    }
    this.notifyResourceUpdated('sandstone://rebuild-state')
  }

  async getRebuildState(): Promise<rpc.GetRebuildStateResult> {
    return { state: this.rebuildState ?? null }
  }

  async publishTestComplete(params: rpc.TestState): Promise<void> {
    this.testState = {
      state: params.state,
      pass: params.pass,
      fail: params.fail,
      durationSec: params.durationSec,
      at: params.at ?? new Date().toISOString(),
      ...(params.message !== undefined ? { message: params.message } : {}),
    }
    this.notifyResourceUpdated('sandstone://test-state')
  }

  async getTestState(): Promise<rpc.GetTestStateResult> {
    return { state: this.testState ?? null }
  }

  async publishWatcherStatus(params: rpc.PublishWatcherStatusParams): Promise<void> {
    this.watcherStatus = {
      connected: params.connected,
      mode: params.mode,
      manual: params.manual,
      testingMode: params.testingMode,
      path: params.path,
      pid: params.pid,
      at: params.at ?? new Date().toISOString(),
    }
    this.notifyResourceUpdated('sandstone://watcher-status')
  }

  async getWatcherStatus(): Promise<rpc.GetWatcherStatusResult> {
    return { status: this.watcherStatus }
  }

  async publishTriggerBuild(): Promise<rpc.PublishTriggerBuildResult> {
    this.broadcast('triggerBuild', { at: new Date().toISOString() })
    return { triggered: true }
  }

  async cancelTriggerBuild(): Promise<rpc.CancelTriggerBuildResult> {
    this.broadcast('cancelTriggerBuild', { at: new Date().toISOString() })
    return { cancelled: true }
  }

  async setBuildMode(params: rpc.SetBuildModeParams): Promise<rpc.SetBuildModeResult> {
    this.broadcast('setBuildMode', { mode: params.mode, at: new Date().toISOString() })
    return { applied: true }
  }

  /** Shutdown RPC entry point — throws `ShutdownSignal` so the WS adapter can finalize. */
  async shutdown(): Promise<void> {
    throw new ShutdownSignal()
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async requireActiveConfig(): Promise<ActiveConfig> {
    if (!this.activeConfig) {
      throw rpcError(
        RpcErrorCode.NotConnected,
        'No active `sandstone.config.ts`. Run `sand connect` from a Sandstone project, or start `sand watch` to publish one.',
      )
    }
    return this.activeConfig
  }

  private parseParams<T extends object>(params: unknown, required: Array<keyof T>): T {
    const obj = (params ?? {}) as Record<string, unknown>
    for (const key of required) {
      if (!(key in obj)) {
        throw rpcError(RpcErrorCode.InvalidParams, `Missing param: ${String(key)}`)
      }
    }
    return obj as T
  }

  private async readBufferLog(
    params: rpc.ReadBuildLogParams | undefined,
    target: 'build' | 'test' | 'server',
  ): Promise<rpc.ReadBuildLogResult> {
    const { tail, maxLines, range, since, until } = this.parseParams<rpc.ReadBuildLogParams>(
      params,
      ['tail', 'maxLines', 'range', 'since', 'until'],
    )
    const buf = target === 'build' ? this.buildBuffer : target === 'test' ? this.testBuffer : this.serverBuffer
    const cfg = await this.requireActiveConfig()
    const path = target === 'build' ? cfg.logPath : target === 'test' ? '<test-runner-buffer>' : '<host-stdout-buffer>'

    const nowMs = Date.now()
    // Time filter: `since`/`until` are seconds-relative-to-now. Convert
    // to ms boundaries against the line's `ts`. `null` = no filter.
    const sinceMs = since != null ? nowMs - since * 1000 : null
    const untilMs = until != null ? nowMs - until * 1000 : null
    const timeFiltered = (sinceMs !== null || untilMs !== null)
      ? buf.filter((e) => {
          if (sinceMs !== null && e.ts < sinceMs) return false
          if (untilMs !== null && e.ts > untilMs) return false
          return true
        })
      : buf

    const { selected, totalLines, matchedLines, truncated, oldestTs, newestTs } = this.selectLines(
      timeFiltered,
      { tail, maxLines, range },
    )

    return {
      path,
      lines: selected.map((e) => e.line),
      totalLines,
      matchedLines,
      oldestTs,
      newestTs,
      truncated,
    }
  }

  private selectLines<T>(
    buf: readonly T[],
    params: { tail: number | null, maxLines: number | null, range: { from: number, to: number } | null },
  ): { selected: T[], totalLines: number, matchedLines: number, truncated: boolean, oldestTs: string | null, newestTs: string | null } {
    const { tail, maxLines, range } = params
    const totalLines = buf.length
    let selected: T[] = buf.slice()
    const matchedLines = selected.length
    if (range) {
      const { from, to } = range
      const len = selected.length
      const startIdx = len - 1 - (from < 0 ? len + from : Math.min(from, len - 1))
      const endIdx = len - 1 - (to < 0 ? len + to : Math.min(to, len - 1))
      const lo = Math.max(0, Math.min(startIdx, endIdx))
      const hi = Math.min(len - 1, Math.max(startIdx, endIdx))
      selected = selected.slice(lo, hi + 1)
    }
    const want = tail ?? maxLines ?? 200
    const truncated = selected.length > want
    const finalLines = truncated ? selected.slice(-want) : selected
    const oldestTs = this.entryTs(finalLines[0])
    const newestTs = this.entryTs(finalLines[finalLines.length - 1])
    return { selected: finalLines, totalLines, matchedLines, truncated, oldestTs, newestTs }
  }

  private entryTs(entry: unknown): string | null {
    if (!entry || typeof entry !== 'object') return null
    const ts = (entry as { ts?: unknown }).ts
    return typeof ts === 'number' ? new Date(ts).toISOString() : null
  }

  private async listDirectory(
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

  private async pumpReadStream(stream: ReadableStream<Uint8Array>, streamId: string, record: OpenStream): Promise<void> {
    const reader = stream.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        record.bytes += value.byteLength
        try {
          for (const [ws] of this.sessions) {
            try { ws.send(encodeStreamChunk(hexToBytes(streamId), value)) } catch {}
          }
        } catch {}
      }
      this.streams.close(streamId, record.bytes)
    } catch (err) {
      this.streams.close(streamId, record.bytes, err instanceof Error ? err : new Error(String(err)))
    }
  }

  private broadcast<K extends RpcEventName>(eventName: K, data: RpcEventMap[K]): void {
    if (this.sessions.size === 0) return
    const envelope = encodeRpc(buildEvent(eventName, data))
    const isShutdown = eventName === 'daemonShutdown'
    for (const [ws, session] of this.sessions) {
      if (isShutdown) session.shuttingDown = true
      try { ws.send(envelope) } catch {}
    }
  }

  private notifyResourceUpdated(uri: string): void {
    if (this.sessions.size === 0) return
    const envelope = encodeRpc(notification('notifications/resources/updated', { uri }))
    for (const [ws] of this.sessions) {
      try { ws.send(envelope) } catch {}
    }
  }

  private findSessionWs(session: SessionContext): SessionWebSocket | undefined {
    for (const [ws, s] of this.sessions) {
      if (s === session) return ws
    }
    return undefined
  }

  private flushLogs(ctx: SessionContext, ws: SessionWebSocket, subscriptionId: string): void {
    const pending = ctx.pendingBySub.get(subscriptionId)
    if (!pending || pending.length === 0) return
    const batch = pending.splice(0, LOG_MAX_BATCH)
    ws.send(encodeRpc(buildEvent('log', { subscriptionId, lines: batch })))
    if (pending.length > 0) {
      ctx.flushTimerBySub.set(subscriptionId, setTimeout(() => {
        ctx.flushTimerBySub.delete(subscriptionId)
        this.flushLogs(ctx, ws, subscriptionId)
      }, LOG_FLUSH_MS))
    } else {
      ctx.pendingBySub.delete(subscriptionId)
    }
  }

  async loadInitialActiveConfig(projectRoot: string): Promise<void> {
    try {
      const loaded = await loadActiveConfigFromDisk(projectRoot)
      this.activeConfig = loaded
    } catch {}
    await this.startClientLogTailFromConfig()
  }

  bindHostDisconnect(onHostLost: () => void): void {
    if (!this.host.onDisconnected) return
    this.host.onDisconnected(() => {
      if (this.expectedShutdown) return
      onHostLost()
    })
  }

  onShutdown(handler: (reason: string) => void): () => void {
    this.shutdownHandlers.add(handler)
    return () => this.shutdownHandlers.delete(handler)
  }

  onTriggerBuild(handler: (event: { at: string }) => void): () => void {
    this.triggerBuildHandlers.add(handler)
    return () => this.triggerBuildHandlers.delete(handler)
  }

  setFallbackNotificationHandler(
    handler: (notif: { method: string; params?: unknown }) => Promise<void> | void,
  ): () => void {
    this.fallbackNotificationHandlers.add(handler)
    return () => this.fallbackNotificationHandlers.delete(handler)
  }

  close(): void {
    for (const sub of this.directSubscriptions.values()) void sub.unattach().catch(() => {})
    this.directSubscriptions.clear()
    this.shutdownHandlers.clear()
    this.triggerBuildHandlers.clear()
    this.fallbackNotificationHandlers.clear()
  }

  private shutdownHandlers = new Set<(reason: string) => void>()
  private triggerBuildHandlers = new Set<(event: { at: string }) => void>()
  private fallbackNotificationHandlers = new Set<(notif: { method: string; params?: unknown }) => Promise<void> | void>()

  async enableWsServer(opts: {
    host: HostProvider
    bind?: string
    port?: number
    projectRoot: string
    fullConfig?: SandstoneConfig
    onShutdown?: () => Promise<void> | void
  }): Promise<DaemonHandle> {
    if (this.wsServer !== null) {
      throw new Error('Daemon: WS server is already live. Call disableWsServer() before re-binding.')
    }
    const status = await endpointStatus(opts.projectRoot)
    if (status === 'live') {
      throw new Error(
        `Daemon: another daemon is already serving ${opts.projectRoot}/.sandstone/connect.url. ` +
          'Shut it down (or remove the endpoint file) before starting a new one.',
      )
    }
    if (status === 'stale' || status === 'live-recent') {
      await deleteEndpoint(opts.projectRoot, process.pid)
    }
    const secret = generateSecret()
    const startedAt = new Date(this.startedAt).toISOString()

    const handle: DaemonHandle = {
      daemon: this,
      url: '',
      port: 0,
      endpoint: { url: '', secret, version: 1, hostType: this.host.type, displayName: this.host.displayName, capabilities: capabilitiesToRecord(this.host.capabilities), pid: process.pid, startedAt, projectRoot: opts.projectRoot, bind: opts.bind ?? '127.0.0.1', port: 0 },
      done: this.donePromise,
      shutdown: () => this.disableWsServer(),
      broadcast: (eventName, data) => this.broadcast(eventName, data),
      notifyResourceUpdated: (uri) => this.notifyResourceUpdated(uri),
    }

    const wsHandler: Bun.WebSocketHandler<WsData> = {
      maxPayloadLength: MAX_PAYLOAD,
      open: (ws) => {
        const session: SessionContext = {
          attachSub: null,
          pendingBySub: new Map(),
          flushTimerBySub: new Map(),
          shuttingDown: false,
        }
        this.sessions.set(ws, session)
        this.logger.info(`[ws] connection opened (${ws.remoteAddress})`)
        const welcome: rpc.WelcomeEvent = {
          protocol: PROTOCOL_VERSION,
          hostType: this.host.type,
          displayName: this.host.displayName,
          capabilities: capabilitiesToRecord(this.host.capabilities),
          pid: process.pid,
          startedAt,
        }
        ws.send(encodeRpc(buildEvent('welcome', welcome)))
      },
      message: (ws, raw) => this.handleWsMessage(ws, raw, handle, opts.onShutdown),
      close: async (ws) => {
        const session = this.sessions.get(ws)
        if (!session) return
        this.sessions.delete(ws)
        for (const timer of session.flushTimerBySub.values()) clearTimeout(timer)
        session.flushTimerBySub.clear()
        await this.waitLogSubs.dropAllForWs(ws.data.secret)
        this.streams.closeAll(new Error('ws session closed'))
        this.logger.info(`[ws] connection closed (${ws.remoteAddress})`)
      },
    }

    this.wsServer = Bun.serve<WsData>({
      hostname: opts.bind,
      port: opts.port ?? 0,
      websocket: wsHandler,
      fetch: (req, srv) => {
        const url = new URL(req.url)
        if (url.pathname === '/health') return new Response('ok')
        const protoHeader = req.headers.get('sec-websocket-protocol')
        if (!protoHeader) return new Response('missing subprotocol', { status: 400 })
        const candidates = protoHeader.split(',').map((s) => s.trim())
        const expected = SUBPROTOCOL_PREFIX + secret
        if (!candidates.includes(expected)) return new Response('bad subprotocol', { status: 401 })
        const upgraded = srv.upgrade(req, { data: { secret }, headers: { 'Sec-WebSocket-Protocol': expected } })
        if (upgraded) return undefined
        return new Response('upgrade failed', { status: 500 })
      },
    })

    const boundPort = this.wsServer.port
    if (typeof boundPort !== 'number') throw new Error('Bun.serve did not bind a port')
    this.wsUrl = `ws://${opts.bind ?? '127.0.0.1'}:${boundPort}`

    handle.url = this.wsUrl
    handle.port = boundPort
    handle.endpoint.url = this.wsUrl
    handle.endpoint.port = boundPort

    await writeEndpoint(opts.projectRoot, handle.endpoint)
    this.endpointFile = handle.endpoint

    await this.loadInitialActiveConfig(opts.projectRoot)

    // Install signal handlers.
    const onSignal = (sig: NodeJS.Signals) => {
       this.logger.error(`\n[connect] received ${sig}, shutting down...`)
      void this.disableWsServer()
    }
    try {
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
      if (process.platform === 'win32') {
        process.on('SIGBREAK', onSignal as (s: NodeJS.Signals) => void)
      }
      process.on('uncaughtException', (err, origin) => {
         this.logger.error(`[daemon] uncaughtException: ${err.message}\n${err.stack ?? '<no stack>'}\n  origin=${typeof origin === 'string' ? origin : 'unknown'}`)
      })
      process.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason))
         this.logger.error(`[daemon] unhandledRejection: ${err.message}\n${err.stack ?? '<no stack>'}`)
      })
    } catch (err) {
       this.logger.error('[connect] failed to register signal handlers:', err)
      try { await deleteEndpoint(opts.projectRoot, process.pid) } catch {}
      throw err
    }

    return handle
  }

  private async handleWsMessage(
    ws: SessionWebSocket,
    raw: string | Uint8Array,
    _handle: DaemonHandle,
    onShutdown?: () => Promise<void> | void,
  ): Promise<void> {
    const session = this.sessions.get(ws)
    if (!session) {
      ws.close(1011, 'no session')
      return
    }

    if (typeof raw !== 'string' && raw.byteLength >= 17 && raw[0] === STREAM_MAGIC) {
      const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
      const { streamId, chunk } = decodeStreamChunk(buf)
      const key = streamIdHex(streamId)
      const stream = this.streams.get(key)
      if (stream && stream.kind === 'writeFile') {
        stream.bytes += chunk.byteLength
        const writer = this.streams.writer(key)
        if (writer) {
          writer.write(chunk).catch((err: unknown) => {
            this.streams.close(key, stream.bytes, err instanceof Error ? err : new Error(String(err)))
          })
        }
      }
      return
    }

    if (session.shuttingDown) {
      const msg = classifyWsMessage(raw)
      if (msg && msg.kind === 'request') {
        ws.send(encodeRpc({ id: msg.id, error: { code: -32006, message: 'daemon shutting down' } }))
      }
      return
    }

    const msg = classifyWsMessage(raw)
    if (!msg) return
    if (msg.kind === 'event') return

    if (msg.kind === 'notification') {
      const notifMethod = msg.method
      const notifStart = Date.now()
       this.logger.error(`[ws] ← notification ${notifMethod} params=${JSON.stringify(msg.params)}`)
      try {
        await this.dispatchNotification(notifMethod, msg.params)
         this.logger.error(`[ws] → notification ${notifMethod} ok (${Date.now() - notifStart}ms)`)
      } catch (e) {
        if (e instanceof ShutdownSignal) {
          this.broadcast('daemonShutdown', { reason: 'shutdown-rpc' })
           this.logger.error(`[ws] → notification ${notifMethod} shutdown-rpc (${Date.now() - notifStart}ms)`)
          queueMicrotask(() => onShutdown?.())
          return
        }
        const rpcErr = e instanceof RpcHandlerError ? e.rpc : {
          code: -32603,
          message: e instanceof Error ? e.message : String(e),
        }
         this.logger.error(`[ws] → notification ${notifMethod} err:${rpcErr.code} ${rpcErr.message} (${Date.now() - notifStart}ms)`)
      }
      return
    }

    if (msg.kind !== 'request') return
    const parsed = msg
    const typedMethod = parsed.method as RpcMethod
    const startMs = Date.now()
     this.logger.error(
      `[ws] ← ${parsed.method} id=${parsed.id}${parsed.params !== undefined ? ` params=${JSON.stringify(parsed.params)}` : ''}`,
    )

    try {
      const result = await this.dispatchRequest(typedMethod, parsed.params as RpcMethodParams[typeof typedMethod], session, ws)
      const response: rpc.RpcResponse = { id: parsed.id, result: result as RpcResult }
      ws.send(encodeRpc(response))
       this.logger.error(
        `[ws] → ${parsed.method} id=${parsed.id} ok result=${JSON.stringify(response.result)} (${Date.now() - startMs}ms)`,
      )
    } catch (e) {
      if (e instanceof ShutdownSignal) {
        ws.send(encodeRpc({ id: parsed.id, result: null }))
        const session = this.sessions.get(ws)
        if (session) {
          for (const subId of session.pendingBySub.keys()) {
            const pending = session.pendingBySub.get(subId) ?? []
            if (pending.length > 0) {
              ws.send(encodeRpc(buildEvent('log', { subscriptionId: subId, lines: pending })))
              session.pendingBySub.delete(subId)
            }
          }
        }
        this.broadcast('daemonShutdown', { reason: 'shutdown-rpc' })
         this.logger.error(`[ws] → ${parsed.method} id=${parsed.id} shutdown-rpc (${Date.now() - startMs}ms)`)
        queueMicrotask(() => onShutdown?.())
        return
      }
      const rpcErr = e instanceof RpcHandlerError ? e.rpc : {
        code: -32603,
        message: e instanceof Error ? e.message : String(e),
      }
      const response: rpc.RpcResponse = { id: parsed.id, error: rpcErr }
      ws.send(encodeRpc(response))
      const status = `err:${rpcErr.code}`
      if (this.expectedShutdown) {
         this.logger.error(
          `[ws] → ${parsed.method} id=${parsed.id} ${status} ${rpcErr.message} (${Date.now() - startMs}ms) — expected shutdown cycle, daemon stays up`,
        )
        return
      }
       this.logger.error(
        `[ws] → ${parsed.method} id=${parsed.id} ${status} ${rpcErr.message} (${Date.now() - startMs}ms) — shutting down`,
      )
      queueMicrotask(() => onShutdown?.())
    }
  }

  private async dispatchRequest<M extends RpcMethod>(
    method: M,
    params: RpcMethodParams[M],
    session: SessionContext,
    ws: SessionWebSocket,
  ): Promise<unknown> {
    if (method === 'readFile') {
      if (!this.host.readFileStream) throw unsupportedCap('readFileStream')
      const info = await this.host.readFileStream((params as rpc.ReadFileParams).path)
      const streamId = streamIdHex(newStreamId())
      const record = this.streams.open({
        streamId,
        direction: 'incoming',
        kind: 'readFile',
        onClose: makeStreamEndBridge(ws, streamId),
      })
      this.pumpReadStream(info.stream, streamId, record).catch((err) => {
        this.logger.error(`pumpReadStream error streamId=${streamId} err=${err instanceof Error ? err.message : String(err)}`)
      })
      return { streamId, totalSize: info.size }
    }
    if (method === 'writeFile') {
      if (!this.host.writeFileStream) throw unsupportedCap('writeFileStream')
      const p = params as rpc.WriteFileParams
      const sink: WritableStream<Uint8Array> = await this.host.writeFileStream(
        p.path,
        p.size !== undefined ? { size: p.size } : undefined,
      )
      const streamId = streamIdHex(newStreamId())
      this.streams.open({
        streamId,
        direction: 'incoming',
        kind: 'writeFile',
        onClose: makeStreamEndBridge(ws, streamId),
      })
      this.streams.attachWriter(streamId, sink.getWriter())
      return { streamId }
    }
    if (method === 'attachLog') {
      const sub = await this.attachLog(params as rpc.AttachLogParams | undefined)
      session.attachSub = { subscriptionId: sub.subscriptionId, unattach: sub.unattach }
      return { subscriptionId: sub.subscriptionId }
    }

    const fn = (this as unknown as Record<string, (p: unknown, s: SessionContext) => Promise<unknown>>)[method]
    if (typeof fn !== 'function') {
      throw rpcError(RpcErrorCode.MethodNotFound, `Unknown method: ${method}`)
    }
    return await fn.call(this, params, session)
  }

  private async dispatchNotification(method: string, params: unknown): Promise<void> {
    const fn = (this as unknown as Record<string, (p: unknown) => Promise<void>>)[method]
    if (typeof fn === 'function') await fn.call(this, params)
  }

  async disableWsServer(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    try {
      this.stopClientLogTail()
      this.broadcast('daemonShutdown', { reason: 'shutdown-rpc' })
      await new Promise<void>((r) => setTimeout(r, SHUTDOWN_BROADCAST_DELAY_MS))
      const ownsServer = this.host.type === 'integrated'
      if (ownsServer && this.host.stopServer) {
        try { await this.host.stopServer() } catch (err) {  this.logger.error('[connect] host stopServer failed:', err) }
      }
      if (this.endpointFile) {
        try { await deleteEndpoint(this.endpointFile.projectRoot, this.endpointFile.pid) } catch (err) {  this.logger.error('[connect] endpoint delete failed:', err) }
      }
      if (this.wsServer) {
        try { await this.wsServer.stop() } catch (err) {  this.logger.error('[connect] ws server stop failed:', err) }
      }
      try { await this.host.disconnect() } catch (err) {  this.logger.error('[connect] host disconnect failed:', err) }
      this.logger.info(`[connect] daemon shutdown complete`)
      this.resolveDone?.()
    } catch (err) {
       this.logger.error('[connect] teardown error:', err)
      this.resolveDone?.()
    }
  }

  setActiveConfig(cfg: ActiveConfig | undefined): void {
    this.activeConfig = cfg
    void this.startClientLogTailFromConfig()
  }

  getWatcherStatusRaw(): rpc.WatcherStatus | null {
    return this.watcherStatus
  }
}

const SUBPROTOCOL_PREFIX = 'sandstone-connect-v1.'