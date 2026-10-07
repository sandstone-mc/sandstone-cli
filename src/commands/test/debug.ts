import * as path from 'path'
import { readdir, unlink } from 'fs/promises'
import { subscribe } from '@parcel/watcher'
import { formatSnbt, type LogExtra } from 'sandstone/test'
import chalk from 'chalk-template'
import type { HostType } from '../../hosts/types.js'
import type {
  CollectionState,
  DebugTraceContent,
  DebugTraceValue,
  DebugWatcher,
  PendingDebug,
  TestEventSink,
  TestLogPayload,
} from './types.js'

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
  _extras: LogExtra[] | undefined,
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

export async function startDebugWatcher(
  hostType: HostType,
  projectRoot: string,
  onDebug: (debug: PendingDebug) => void,
): Promise<DebugWatcher | null> {
  if (hostType !== 'integrated') return null
  const debugDir = path.join(projectRoot, '.sandstone', 'mc-server', 'debug')

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
      await ingestTraceFile(path.join(debugDir, existing))
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