import path, { join, resolve } from 'path'
import { initTestLogger, logInfo } from '../ui/logger.js'
import { readdir, unlink } from 'fs/promises'
import { subscribe } from '@parcel/watcher'
import { connect as openClient, type Client } from './connect/client.js'
import { pidAlive, readEndpoint } from './connect/endpoint-file.js'
import { BootstrapError, bootstrapHost } from './connect/bootstrap.js'
import { KNOWN_HOST_TYPES } from '../hosts/types.js'
import type { HostProvider, HostType, HostLogHandler, LogSubscription } from '../hosts/types.js'
import { DEFAULT_HOST_TYPE } from './connect/index.js'
import { parseHostConfig } from './connect/host-config.js'
import { formatSnbt, parseFailureLog, type ParsedFailureLog, type LogExtra } from 'sandstone/test'
import { printSplash } from '../utils/index.js'
import chalk from 'chalk-template'
import type { ExecuteRawCommandResult } from './connect/rpc.js'

export type TestEvent = (
  {
    event: 'status',
    message: string,
    type?: 'daemon_connected' | 'host_bootstrapping' | 'tests_running' | 'server_stopping' | 'tests_cancelled' | (string & {}),
    url?: string,
    host_type?: string,
  } | {
    event: 'error',
    message: string,
  } | {
    event: 'test_log',
    message: string,
    level: string,
    trace?: string | number,
    server_trace?: ErrorTrace,
    build_trace?: ErrorTrace,
    debug?: true,
    debug_trace?: DebugTraceContent,
  } | {
    event: 'test_result',
    name: string,
    description?: string,
    passed: boolean,
    optional: boolean,
    ticks_elapsed: number,
    error?: {
      message: string,
      position: [number, number, number],
      server_trace: ErrorTrace,
      build_trace?: ErrorTrace,
    },
    source_file?: string,
  } | {
    event: 'server_log',
    line: string,
    source?: string,
    level?: string,
  } | {
    event: 'summary',
    total: number,
    pass: number,
    fail: number,
    required_count: number,
    optional_count: number,
    elapsed_ms: number,
    file_count: number,
  }
)

/** Payload of a `TestEvent.test_log` variant, minus the discriminator
 *  (which is set in `emitTestLog`). Used for `PendingLog.payload` and
 *  for the parsed `%test-log%` JSON. */
export type TestLogPayload = Omit<Extract<TestEvent, { event: 'test_log' }>, 'event'>

/** Parsed JSON body of a `.sandstone/mc-server/debug/<trace>.txt` file.
 *  Provides the `values` array paired with the in-flight `test_log`. */
export interface DebugTraceContent {
  trace: string,
  values?: DebugTraceValue[],
}

export type TestEventSink = (event: TestEvent) => void

export interface TestCommandOptions {
  hostType?: string
  hostConfig?: string
  hostConfigFile?: string
  path: string
  /** `--json`: emit one minified JSON object per event (status, error,
   *  per-test, warning, summary) on stdout instead of formatted+colored
   *  text. Suppresses the splash banner. */
  json?: boolean
}

const TRIGGER_PREFIX = 'Running test environment'
const COMPLETE_PREFIX = 'Game Test complete!'
const TEST_COMMAND = 'test run *:*'
const LOG_PREFIX_RE = /^\[\d{2}:\d{2}:\d{2}\] \[([^\]]+)\/(\w+)\]: (.*)$/
const TEST_LOG_RE = /%test-log%(.*?)%\/test-log%/
const RCON_START_ECHO_RE =
  /^System chat: \[Rcon: Starting environment [a-z0-9\-_]+:[a-z0-9\-_]+ batch \d+\]$/

interface TestEntry {
  name: string
  description?: string
  optional?: boolean
  sourceFile?: string
  sourceLine?: number
  sourceColumn?: number
}

interface ThrowableEntry {
  trace?: ErrorTrace
  command?: string
  line?: number
}

interface TestsManifest {
  tests: TestEntry[]
  /** Keyed by `${namespace}:${name}@${command}:${sourceLine}` */
  throwables: Record<string, ThrowableEntry>
  log_traces: Record<`${number}`, { server_trace: ErrorTrace; build_trace?: ErrorTrace; extras?: LogExtra[] }>
}

async function loadTestsManifest(projectRoot: string): Promise<TestsManifest | null> {
  const path = resolve(projectRoot, '.sandstone', 'tests.json')
  let text: string
  try {
    text = await Bun.file(path).text()
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as { tests?: unknown; throwables?: unknown; log_traces?: unknown }
    const raw = Array.isArray(parsed.tests) ? parsed.tests : []
    const entries: TestEntry[] = []
    for (const item of raw) {
      const e = item as { name: string; description?: unknown; optional?: unknown; sourceFile?: unknown; sourceLine?: unknown; sourceColumn?: unknown }
      const sourceFile = typeof e.sourceFile === 'string' ? e.sourceFile : undefined
      entries.push({
        name: e.name,
        description: typeof e.description === 'string' ? e.description : undefined,
        optional: typeof e.optional === 'boolean' ? e.optional : undefined,
        ...(sourceFile !== undefined ? {
          sourceFile,
          sourceLine: typeof e.sourceLine === 'number' ? e.sourceLine : 0,
          sourceColumn: typeof e.sourceColumn === 'number' ? e.sourceColumn : 0,
        } : {}),
      })
    }
    const throwables: Record<string, ThrowableEntry> =
      parsed.throwables && typeof parsed.throwables === 'object'
        ? (parsed.throwables as Record<string, ThrowableEntry>)
        : {}
    const log_traces: TestsManifest['log_traces'] =
      parsed.log_traces && typeof parsed.log_traces === 'object'
        ? (parsed.log_traces as TestsManifest['log_traces'])
        : {}
    return { tests: entries, throwables, log_traces }
  } catch {
    return null
  }
}

function emitStatus(
  message: string,
  onEvent: TestEventSink,
  type?: string,
  fields?: Record<string, unknown>,
): void {
  onEvent({
    event: 'status',
    message,
    ...(type !== undefined ? { type } : {}),
    ...(fields ?? {}),
  } as TestEvent)
}

function emitError(message: string, onEvent: TestEventSink): void {
  onEvent({ event: 'error', message })
}

export function formatDebugTraceValues(
  values: DebugTraceValue[],
  extras: LogExtra[] | undefined,
  keyword: string,
): string {
  if (extras === undefined || extras.length === 0) return ''

  const pad = ' '.repeat(Math.max(0, keyword.length - 'ext'.length))
  const bulletPad = pad + ' '
  const lines = [chalk`${pad}ext{gray :}`]

  for (let i = 0; i < extras.length; i++) {
    const extra = extras[i]!
    const parsed = values[i + 1]
    let valueRendered: string
    if (parsed?.snbt !== undefined) {
      valueRendered = formatSnbt(parsed.snbt)
    } else if (parsed?.result !== undefined) {
      valueRendered = chalk`{green ${parsed.result}}`
    } else {
      valueRendered = '?'
    }
    lines.push(chalk`${bulletPad}{gray - }${extra.name}{gray :} ${valueRendered}{gray ,}`)
  }
  lines.push('')
  return lines.join('\n')
}

export function emitTestLog(
  payload: TestLogPayload,
  debug: DebugTraceContent | undefined,
  extras: LogExtra[] | undefined,
  onEvent: TestEventSink,
): void {
  const merged: TestLogPayload = { ...payload, debug: true }
  if (debug !== undefined) merged.debug_trace = debug
  onEvent({ event: 'test_log', ...merged })
}

export function flushPendingLogs(state: CollectionState, onEvent: TestEventSink): void {
  for (const [, pending] of state.pendingLogs) {
    emitTestLog(pending.payload, undefined, undefined, onEvent)
  }
  state.pendingLogs.clear()
}

export interface DebugTraceValue {
  command: string
  snbt?: string
  result?: string
}

const DEBUG_TRACE_C_RE = /^\s*\[C\]\s+(.+)$/
const DEBUG_TRACE_M_RE = /^\s*\[M]\s+.*has the following contents:\s*(.+)$/
const DEBUG_TRACE_R_RE = /^\s*\[R\s*=\s*(.+?)\s*\]\s+(.+)$/

export function parseDebugTrace(body: string): DebugTraceValue[] {
  const out: DebugTraceValue[] = []
  let current: DebugTraceValue | undefined
  for (const line of body.split('\n')) {
    const cMatch = line.match(DEBUG_TRACE_C_RE)
    if (cMatch !== null) {
      current = { command: cMatch[1]!.trim() }
      out.push(current)
      continue
    }
    if (current === undefined) continue
    const mMatch = line.match(DEBUG_TRACE_M_RE)
    if (mMatch !== null) {
      current.snbt = mMatch[1]!.trim()
      continue
    }
    const rMatch = line.match(DEBUG_TRACE_R_RE)
    if (rMatch !== null) {
      current.result = rMatch[1]!.trim()
      current = undefined
    }
  }
  return out
}

export async function startDebugWatcher(
  hostType: HostType,
  projectRoot: string,
  onDebug: (debug: PendingDebug) => void,
): Promise<DebugWatcher | null> {
  if (hostType !== 'integrated') return null
  const debugDir = join(projectRoot, '.sandstone', 'mc-server', 'debug')

  const ingestTraceFile = async (filePath: string): Promise<void> => {
    let body: string
    try {
      body = await Bun.file(filePath).text()
    } catch {
      return
    }
    const firstLine = body.split('\n', 1)[0]
    if (firstLine === undefined) return
    const slash = firstLine.lastIndexOf('/')
    const colon = firstLine.lastIndexOf(':')
    const traceId = firstLine.slice(Math.max(slash, colon) + 1).trim()
    if (traceId === '') return
    onDebug({
      content: {
        trace: traceId,
        values: parseDebugTrace(body),
      },
      filePath,
    })
  }
  for (const existing of await readdir(debugDir).catch(() => [])) {
    if (existing.endsWith('.txt')) {
      await ingestTraceFile(join(debugDir, existing))
    }
  }

  const subscription = await subscribe(
    debugDir,
    (err, events) => {
      if (err !== null) return
      for (const event of events) {
        if (event.type === 'create' && event.path.endsWith('.txt')) {
          void ingestTraceFile(event.path)
        }
      }
    },
  )

  return {
    ingest: onDebug,
    close: async () => {
      await subscription.unsubscribe().catch(() => {})
    },
  }
}

export async function runTests(
  opts: TestCommandOptions,
  signal?: AbortSignal,
  onEvent?: TestEventSink,
  existingClient?: Client,
): Promise<number> {
  const projectRoot = resolve(opts.path)
  const sink: TestEventSink = onEvent ?? ((e) => console.log(JSON.stringify(e)))

  const manifest = await loadTestsManifest(projectRoot)
  if (!manifest) {
    emitError(
      'Test manifest not found. Run `sand build --test` to generate tests, then retry.',
      sink,
    )
    return 2
  }

  if (existingClient) {
    emitStatus(chalk`Using watcher-owned \`sand connect\` client`, sink, 'daemon_connected', { url: '' })
    return runDaemon(undefined, manifest, sink, projectRoot, signal, existingClient)
  }

  const endpoint = await readEndpoint(projectRoot)
  const daemonAlive = !!(endpoint && (await pidAlive(endpoint.pid)))
  if (daemonAlive && endpoint) {
    emitStatus(
      chalk`Using existing \`sand connect\` daemon at {cyan ${endpoint.url}}`,
      sink,
      'daemon_connected',
      { url: endpoint.url },
    )
  } else {
    emitStatus(
      chalk`Bootstrapping {bold ${opts.hostType ?? DEFAULT_HOST_TYPE}} host...`,
      sink,
      'host_bootstrapping',
      { host_type: opts.hostType ?? DEFAULT_HOST_TYPE },
    )
  }

  let hostType: HostType | undefined
  if (opts.hostType) {
    if (opts.hostType.includes(',')) {
      emitError(
        `Only one --host-type is supported, got '${opts.hostType}'. Composite daemons were removed.`,
        sink,
      )
      return 2
    }
    hostType = opts.hostType as HostType
  }
  const userProvidedHostSettings = !!opts.hostType || !!opts.hostConfig || !!opts.hostConfigFile
  if (!daemonAlive) {
    if (!hostType) hostType = DEFAULT_HOST_TYPE
    if (!KNOWN_HOST_TYPES.has(hostType as HostType)) {
      emitError(`Unknown --host-type '${hostType}'`, sink)
      return 2
    }
    if (opts.hostConfig && opts.hostConfigFile) {
      emitError('Pass either --host-config or --host-config-file, not both', sink)
      return 2
    }
    if (!opts.hostConfig && !opts.hostConfigFile) {
      opts.hostConfig = JSON.stringify({})
    }
  }
  const resolvedHostType: HostType = hostType ?? DEFAULT_HOST_TYPE

  if (daemonAlive && endpoint) {
    return runDaemon(endpoint, manifest, sink, projectRoot, signal)
  }

  return runDirect(projectRoot, resolvedHostType, opts, userProvidedHostSettings, manifest, sink, signal)
}

export async function testCommand(opts: TestCommandOptions): Promise<void> {
  const json = opts.json === true
  if (!json) printSplash()
  const closeFileLogger = initTestLogger(opts.path)
  const sink: TestEventSink = json
    ? (e) => { logInfo(JSON.stringify(e)) }
    : (e) => { for (const line of renderTestEvent(e)) logInfo(line) }
  try {
    process.exit(await runTests(opts, undefined, sink))
  } finally {
    await closeFileLogger()
  }
}

interface TestSession {
  attachLog(handler: HostLogHandler): Promise<LogSubscription>
  executeRawCommand(): Promise<string | ExecuteRawCommandResult | undefined>
  cleanup(): Promise<void>
}

async function runSession(
  session: TestSession,
  manifest: TestsManifest,
  onEvent: TestEventSink,
  hostType: HostType,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<number> {
  const startMs = Date.now()
  const state = {
    collecting: false,
    failed: new Set<string>(),
    failedRecap: [],
    optionalErrors: new Set<string>(),
    pendingLogs: new Map(),
    pendingDebugs: new Map(),
  }

  const debugWatcher = await startDebugWatcher(hostType, projectRoot, (debug) => {
    const key = debug.content.trace as `${number}`
    const extras = manifest.log_traces[key]?.extras
    pairDebugTrace(state, debug, extras, onEvent)
  })
  let resolveComplete!: () => void
  let rejectAborted!: (err: Error) => void
  const completed = new Promise<void>((resolve, reject) => {
    resolveComplete = resolve
    rejectAborted = reject
  })
  if (signal !== undefined) {
    if (signal.aborted) rejectAborted(new Error('aborted'))
    else signal.addEventListener('abort', () => rejectAborted(new Error('aborted')), { once: true })
  }

  const subscription = await session.attachLog((lines) => {
    if (signal?.aborted === true) return
    for (const entry of lines) {
      processLine(entry.line, state, manifest, onEvent)
      if (entry.line.includes(COMPLETE_PREFIX) && !state.collecting) {
        resolveComplete()
      }
    }
  })
  emitStatus(chalk`Running tests...`, onEvent, 'tests_running')
  const cmdPromise = session.executeRawCommand().catch(() => undefined)

  let exitCode = 0
  try {
    await completed
    flushPendingLogs(state, onEvent)
    printSummary(state, manifest, Date.now() - startMs, onEvent)
    exitCode = state.failed.size > 0 ? 1 : 0
    await cmdPromise.catch(() => {})
  } catch (err) {
    if (signal?.aborted === true) {
      flushPendingLogs(state, onEvent)
      emitStatus('Tests cancelled by user', onEvent, 'tests_cancelled')
      exitCode = 130
    } else {
      emitError(err instanceof Error ? err.message : String(err), onEvent)
      exitCode = 1
    }
  } finally {
    await subscription.unattach().catch(() => {})
    await debugWatcher?.close().catch(() => {})
    await session.cleanup()
  }
  return exitCode
}

async function runDaemon(
  endpoint: NonNullable<Awaited<ReturnType<typeof readEndpoint>>> | undefined,
  manifest: TestsManifest,
  onEvent: TestEventSink,
  projectRoot: string,
  signal?: AbortSignal,
  existingClient?: Client,
): Promise<number> {
  const ownsClient = !existingClient
  const client = existingClient ?? (await openClient({ endpoint: endpoint! }))
  if (!client.welcome.capabilities.executeRawCommand) {
    emitError('Host does not support executeRawCommand', onEvent)
    if (ownsClient) client.close()
    process.exit(2)
  }
  if (!client.welcome.capabilities.attachLog) {
    emitError('Host does not support attachLog', onEvent)
    if (ownsClient) client.close()
    process.exit(2)
  }

  const hostType = client.welcome.hostType as HostType
  return runSession(
    {
      attachLog: async (handler) => client.attachLog().then((sub) => {
        sub.onLines((lines) => handler(lines))
        return sub
      }),
      executeRawCommand: () => client.executeRawCommand({ command: TEST_COMMAND }),
      cleanup: () => {
        if (ownsClient) client.close()
        return Promise.resolve()
      },
    },
    manifest,
    onEvent,
    hostType,
    projectRoot,
    signal,
  )
}

async function runDirect(
  projectRoot: string,
  resolvedHostType: HostType,
  opts: TestCommandOptions,
  userProvidedHostSettings: boolean,
  manifest: TestsManifest,
  onEvent: TestEventSink,
  signal?: AbortSignal,
): Promise<number> {
  const parsedConfig = await parseHostConfig(opts.hostConfig, opts.hostConfigFile)
  const hostConfig = parsedConfig.config
  if (hostConfig.projectRoot === undefined) hostConfig.projectRoot = projectRoot

  let host: HostProvider
  let weStarted = false
  try {
    const result = await bootstrapHost({
      hostType: resolvedHostType,
      config: hostConfig,
      silent: true,
      userProvidedHostSettings,
    })
    host = result.host
    weStarted = result.spawnedByUs
  } catch (err) {
    const msg =
      err instanceof BootstrapError
        ? `${err.message} (${err.code})`
        : err instanceof Error
          ? err.message
          : String(err)
    emitError(msg, onEvent)
    process.exit(2)
  }

  if (!host.capabilities.has('executeRawCommand')) {
    emitError(`Host '${resolvedHostType}' does not support executeRawCommand`, onEvent)
    await safeDisconnect(host)
    process.exit(2)
  }
  if (!host.capabilities.has('attachLog') || !host.attachLog) {
    emitError(`Host '${resolvedHostType}' does not support attachLog`, onEvent)
    await safeDisconnect(host)
    process.exit(2)
  }

  return runSession(
    {
      attachLog: (handler) => host.attachLog!(handler),
      executeRawCommand: () => host.executeRawCommand!(TEST_COMMAND),
      cleanup: async () => {
        if (weStarted && host.type === 'integrated' && host.stopServer && host.capabilities.has('stopServer')) {
          emitStatus('Stopping server...', onEvent, 'server_stopping')
          await host.stopServer().catch(() => {})
        }
        await safeDisconnect(host)
      },
    },
    manifest,
    onEvent,
    host.type,
    projectRoot,
    signal,
  )
}

export interface CollectionState {
  collecting: boolean
  failed: Set<string>
  /** Pre-rendered "✗ <ns:id> > <desc> [<tick>t]" lines. */
  failedRecap: string[]
  /** Test names that emitted at least one optional failure. */
  optionalErrors: Set<string>
  pendingLogs: Map<`${number}`, PendingLog>
  pendingDebugs: Map<`${number}`, PendingDebug>
}

export interface PendingLog {
  /** The expanded payload object (server_trace / build_trace baked in,
   *  raw `trace` field removed). This is what gets emitted. */
  payload: TestLogPayload
}

export function pairDebugTrace(
  state: CollectionState,
  debug: PendingDebug,
  extras: LogExtra[] | undefined,
  onEvent: TestEventSink,
): boolean {
  const key = debug.content.trace as `${number}`
  const pendingLog = state.pendingLogs.get(key)
  if (pendingLog !== undefined) {
    state.pendingLogs.delete(key)
    void unlink(debug.filePath).catch(() => {})
    emitTestLog(pendingLog.payload, debug.content, extras, onEvent)
    return true
  }
  state.pendingDebugs.set(key, debug)
  return false
}

export function pairLogLine(
  state: CollectionState,
  traceKey: `${number}`,
  payload: TestLogPayload,
  extras: LogExtra[] | undefined,
  onEvent: TestEventSink,
): boolean {
  const pendingDebug = state.pendingDebugs.get(traceKey)
  if (pendingDebug !== undefined) {
    state.pendingDebugs.delete(traceKey)
    void unlink(pendingDebug.filePath).catch(() => {})
    emitTestLog(payload, pendingDebug.content, extras, onEvent)
    return true
  }
  state.pendingLogs.set(traceKey, { payload })
  return false
}

export interface PendingDebug {
  /** Parsed JSON body of the trace file. */
  content: DebugTraceContent
  filePath: string
}

export interface DebugWatcher {
  ingest: (debug: PendingDebug) => void
  close: () => Promise<void>
}

function processLine(
  line: string,
  state: CollectionState,
  manifest: TestsManifest,
  onEvent: TestEventSink,
): void {
  if (line.includes(TRIGGER_PREFIX)) {
    state.collecting = true
    return
  }
  if (line.includes(COMPLETE_PREFIX)) {
    state.collecting = false
    return
  }
  if (!state.collecting) return

  const parsed = parseFailureLog(line)
  if (parsed) {
    const entry = manifest.tests.find((t) => t.name === parsed.source)
    const optional = parsed.optional || entry?.optional === true
    if (optional) {
      state.optionalErrors.add(parsed.source)
    } else {
      state.failed.add(parsed.source)
    }
    const throwableKey = findThrowableKey(parsed, manifest.throwables)
    const throwable = throwableKey !== undefined ? manifest.throwables[throwableKey] : undefined
    const [namespace, id] = parsed.source.split(':')
    const anonymous = parsed.line === 0
    const serverTrace = {
      blame: anonymous ? '<anonymous>' : 'fail',
      file: join(process.cwd(), '.sandstone', 'output', 'datapack', 'data', namespace, 'test', `${id.replaceAll('/', path.sep)}.mcfunction`),
      line: parsed.line || 1,
      column: 0,
    }
    const buildTrace = buildTraceFromFailure(throwable, entry)

    onEvent({
      event: 'test_result',
      name: parsed.source,
      ...(entry?.description !== undefined ? { description: entry.description } : {}),
      passed: optional,
      optional,
      ticks_elapsed: parsed.tick ?? 0,
      error: {
        message: parsed.message,
        position: [parsed.x, parsed.y, parsed.z],
        server_trace: serverTrace,
        ...(buildTrace ? { build_trace: buildTrace } : {}),
      },
    })

    if (!parsed.optional) {
      // Cache the already-formatted header so `printSummary` doesn't
      // re-run `formatTestResult` for the recap.
      state.failedRecap.push(formatTestResult(entry, parsed.source, optional, optional, parsed.tick))
    }
    return
  }

  const parsedPrefix = line.match(LOG_PREFIX_RE)
  const content = parsedPrefix ? parsedPrefix[3] : line
  if (RCON_START_ECHO_RE.test(content)) return
  const logMatch = content.match(TEST_LOG_RE)
  if (logMatch) {
    try {
      const rawPayload = JSON.parse(logMatch[1]) as TestLogPayload
      const payload: TestLogPayload = { ...rawPayload }
      const traceId = payload.trace as `${number}` | undefined
      if (traceId !== undefined) {
        const entry = manifest.log_traces[traceId]
        if (entry) {
          payload.server_trace = entry.server_trace
          if (payload.build_trace === undefined && entry.build_trace !== undefined) {
            payload.build_trace = entry.build_trace
          }
        }
        if (payload.debug) {
          delete payload.trace
          pairLogLine(state, traceId, payload, manifest.log_traces[traceId]?.extras, onEvent)
          return
        }
      }
      onEvent({ event: 'test_log', ...payload } as TestEvent)
      return
    } catch {}
  }
  const event: TestEvent = {
    event: 'server_log',
    line: content,
    ...(parsedPrefix !== null ? {
      source: parsedPrefix[1]!,
      level: parsedPrefix[2] === 'WARN' ? 'warning' : parsedPrefix[2]!.toLowerCase(),
    } : {}),
  }
  onEvent(event)
}

function formatTestResult(
  entry: TestEntry | undefined,
  source: string,
  passed: boolean,
  optional: boolean,
  tick: number | null,
): string {
  let header = ''
  header += passed ? chalk`{green ✔} ` : chalk`{red ✗} `
  header += chalk`{yellowBright ${source}}`
  if (optional) header += chalk` {gray (optional)}`
  header += chalk` {gray >} `
  header += entry?.description ? chalk`{bold ${entry.description}}` : '(no description)'
  if (tick !== null) header += chalk` {gray [${tick}t]}`
  return header
}

function findThrowableKey(
  failure: ParsedFailureLog,
  throwables: Record<string, ThrowableEntry>,
): string | undefined {
  const prefix = `${failure.source}@`
  const suffix = `:${failure.line}`
  for (const key of Object.keys(throwables)) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) return key
  }
  return undefined
}

function buildTraceFromFailure(
  throwable: ThrowableEntry | undefined,
  entry: TestEntry | undefined,
): ErrorTrace | undefined {
  if (throwable?.trace?.file !== undefined) {
    return {
      blame: 'Test#create',
      file: throwable.trace.file,
      line: throwable.trace.line ?? 1,
      column: throwable.trace.column ?? 0,
    }
  }
  if (entry?.sourceFile === undefined) return undefined
  return {
    blame: 'Test#create',
    file: entry.sourceFile,
    line: entry.sourceLine!,
    column: entry.sourceColumn!,
  }
}

interface ErrorTrace {
  blame: string
  file: string
  line: number
  column?: number
}

function formatDiagnostic(
  message: string,
  stackTrace: ErrorTrace[],
  options?: {
    keyword?: string,
    keywordColor?: string,
    position?: [number, number, number],
    footer?: string,
  }
): string {
  const keyword = options?.keyword ?? 'error'
  let out = ''
  out += chalk`\n{${options?.keywordColor ?? 'red'} ${keyword}}{gray :} {bold ${message}}`
  if (options?.position !== undefined) {
    const [ x, y, z ] = options.position
    out += chalk`\n  pos{gray :} {greenBright ${x} ${y} ${z}}{gray ,}\n`
  }
  for (const trace of stackTrace) {
    let frame = chalk`\n${' '.repeat(6)}{gray at} {bold {italic ${trace.blame ?? '<anonymous>'}}} `
    if (trace.file !== undefined) {
      frame += chalk`{gray (}`
      const cwd = process.cwd()
      const datapackOutput = join(cwd, '.sandstone', 'output', 'datapack', 'data')
      if (trace.file.startsWith(datapackOutput)) {
        frame += chalk`{blue ${datapackOutput}${path.sep}}{cyan ${trace.file.slice(datapackOutput.length + 1)}}`
      } else if (trace.file.startsWith(cwd)) {
        frame += chalk`{blue ${cwd}${path.sep}}{cyan ${trace.file.slice(cwd.length + 1)}}`
      } else {
        frame += chalk`{cyan ${trace.file}}`
      }
      frame += chalk`{gray :}`
      if (trace.line !== undefined) frame += chalk`{yellowBright ${trace.line}}`
      frame += chalk`{gray :}{yellow ${trace.column ?? 0}}{gray )}`
    }
    out += frame
  }
  if (options?.footer !== undefined) out += `\n${options.footer}`
  return out
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(2)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function printSummary(
  state: CollectionState,
  manifest: TestsManifest,
  elapsedMs: number,
  onEvent: TestEventSink,
): void {
  let requiredCount = 0
  let optionalCount = 0
  for (const t of manifest.tests) {
    if (t.optional === true) optionalCount++
    else requiredCount++
  }

  const failedSources = state.failed
  const allErroredSources = new Set<string>([...failedSources, ...state.optionalErrors])

  const total = manifest.tests.length
  const fail = failedSources.size
  const pass = total - fail
  const fileCount = new Set(manifest.tests.map((t) => t.sourceFile ?? '')).size

  for (const t of manifest.tests) {
    if (allErroredSources.has(t.name)) continue
    onEvent({
      event: 'test_result',
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      passed: true,
      optional: t.optional === true,
      ticks_elapsed: 0,
      ...(t.sourceFile !== undefined ? { source_file: t.sourceFile } : {}),
    })
  }

  onEvent({
    event: 'summary',
    total,
    pass,
    fail,
    required_count: requiredCount,
    optional_count: optionalCount,
    elapsed_ms: elapsedMs,
    file_count: fileCount,
  })
}

async function safeDisconnect(host: HostProvider): Promise<void> {
  try {
    await host.disconnect()
  } catch {}
}

export function renderTestEvent(event: TestEvent): string[] {
  switch (event.event) {
    case 'status': {
      const message = event.message
      const text = chalk`{cyan [test]} ${message}`
      return [text]
    }
    case 'error': {
      return [chalk`{red Error:} ${event.message}`]
    }
    case 'test_log': {
      const level = typeof event.level === 'string' ? event.level : 'info'
      const values = Array.isArray(
        event.debug_trace?.values,
      )
        ? (event as { debug_trace: { values: DebugTraceValue[] } }).debug_trace.values
        : []
      const footer = formatDebugTraceValues(values, undefined, level)
      const out = formatDiagnostic(
        typeof event.message === 'string' ? event.message : '',
        [
          event.server_trace as ErrorTrace,
          ...(event.build_trace !== undefined ? [event.build_trace as ErrorTrace] : []),
        ],
        {
          keyword: level,
          keywordColor: level === 'warning' ? 'yellow' : level === 'info' ? 'white' : 'red',
          ...(footer !== '' ? { footer: '\n' + footer } : {}),
        },
      )
      return [out]
    }
    case 'test_result': {
      const entry: TestEntry | undefined = undefined
      const line = formatTestResult(
        entry,
        event.name,
        event.passed,
        event.optional,
        event.ticks_elapsed || null,
      )
      if (event.error !== undefined) {
        const trace: ErrorTrace[] = []
        if (event.error.server_trace !== undefined) trace.push(event.error.server_trace as ErrorTrace)
        if (event.error.build_trace !== undefined) trace.push(event.error.build_trace as ErrorTrace)
        const diag = formatDiagnostic(
          event.error.message,
          trace,
          {
            keyword: 'error',
            keywordColor: 'red',
            position: event.error.position,
            footer: '\n' + line,
          },
        )
        return [diag]
      }
      return ['\n' + line]
    }
    case 'server_log': {
      const level = event.level
      let levelColor: string | undefined
      if (level === 'warning') levelColor = 'yellow'
      else if (level === 'error') levelColor = 'red'
      const prefix = level !== undefined && level !== 'info'
        ? chalk`{${levelColor} ${level}}{gray :} `
        : ''
      return [chalk`{cyan [connect]} ${prefix}${event.line}`]
    }
    case 'summary': {
      const lines: string[] = []
      const fail = event.fail
      const pass = event.pass
      const total = event.total
      const fileCount = event.file_count
      lines.push(
        chalk`\n {green ${pass} pass}`,
        chalk`\n {${fail === 0 ? 'gray' : 'red'} ${fail} fail}`,
        chalk`\nRan ${total} test${total === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}. {gray [${formatMs(event.elapsed_ms)}]}`,
      )
      return lines
    }
  }
}