import * as path from 'path'
import chalk from 'chalk-template'
import { flushPendingLogs, pairDebugTrace, pairLogLine, startDebugWatcher } from './debug.js'
import { emitError, emitStatus } from './events.js'
import { formatTestResult } from './format.js'
import { parseFailureLog, type ParsedFailureLog } from './logParser.js'
import type { HostLogHandler, HostType, LogSubscription } from '../../hosts/types.js'
import type { ExecuteRawCommandResult } from '../connect/rpc.js'
import type {
  CollectionState,
  ErrorTrace,
  TestEvent,
  TestEventSink,
  TestEntry,
  TestLogPayload,
  TestsManifest,
  ThrowableEntry,
} from './types.js'

const TRIGGER_PREFIX = 'Running test environment'
const COMPLETE_PREFIX = 'Game Test complete!'
const LOG_PREFIX_RE = /^\[\d{2}:\d{2}:\d{2}\] \[([^\]]+)\/(\w+)\]: (.*)$/
const TEST_LOG_RE = /%test-log%(.*?)%\/test-log%/
const RCON_START_ECHO_RE =
  /^System chat: \[Rcon: Starting environment [a-z0-9\-_]+:[a-z0-9\-_]+ batch \d+\]$/

export interface TestSession {
  attachLog(handler: HostLogHandler): Promise<LogSubscription>
  executeRawCommand(): Promise<string | ExecuteRawCommandResult | undefined>
  cleanup(): Promise<void>
}

export async function runSession(
  session: TestSession,
  manifest: TestsManifest,
  onEvent: TestEventSink,
  hostType: HostType,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<number> {
  const startMs = Date.now()
  const state: CollectionState = {
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
      file: path.join(process.cwd(), '.sandstone', 'output', 'datapack', 'data', namespace, 'test', `${id.replaceAll('/', path.sep)}.mcfunction`),
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
        ...(buildTrace !== undefined ? { build_trace: buildTrace } : {}),
      },
    })

    if (!parsed.optional) {
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
      const payload = JSON.parse(logMatch[1]) as TestLogPayload
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