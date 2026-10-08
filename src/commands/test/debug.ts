import * as path from 'path'
import { readdir, unlink } from 'fs/promises'
import * as fs from '../../utils/fs.js'
import { subscribe } from '@parcel/watcher'
import { formatSnbt, type LogExtra } from 'sandstone/test'
import chalk from 'chalk-template'
import type { HostType } from '../../hosts/types.js'
import type {
  CollectionState,
  DebugTraceContent,
  DebugVariable,
  DebugWatcher,
  PendingDebug,
  TestEventSink,
  TestLogPayload,
} from './types.js'

export type DebugLog = (message: string) => void

const DEBUG_TRACE_COMMAND = /^\[C\] (.+)$/
const DEBUG_TRACE_MESSAGE = /^\[M\] .* has the following contents: (.+)$/
const DEBUG_TRACE_RETURN = /^\[R = (\d+)\] (.+)$/

export function parseDebugTrace(body: string, extras: LogExtra[], _debugLog: DebugLog): DebugVariable[] {
  const variables: DebugVariable[] = []
  let current: Partial<DebugVariable> | undefined

  for (const _line of body.split('\n').slice(3)) {
    const line = _line.trimStart()
    const command = line.match(DEBUG_TRACE_COMMAND)
    if (command !== null) {
      const variable = extras[variables.length]

      if (variable === undefined) break

      current = {
        type: variable.type,
        name: variable.name,
        source: variable.source,
        target: variable.target
      }
      continue
    }
    if (current === undefined) continue
    const message = line.match(DEBUG_TRACE_MESSAGE)
    if (message !== null) {
      if (current.type === 'data') {
        current.snbt = message[1]
      }
      continue
    }
    const returnValue = line.match(DEBUG_TRACE_RETURN)
    if (returnValue !== null) {
      const parsed = Number.parseInt(returnValue[1], 10)
      if (Number.isFinite(parsed)) current.return_value = parsed
    }

    if (current.return_value !== undefined) {
      if (current.type === 'data' && current.snbt !== '') {
        variables.push(current as DebugVariable)
        continue
      }
      variables.push(current as DebugVariable)
      current = undefined
    }
  }
  return variables
}

export function formatDebugTraceValues(
  variables: DebugVariable[],
  keyword: string,
): string {
  const pad = ' '.repeat(Math.max(0, keyword.length - 'ext'.length))
  const bulletPad = pad + ' '
  const lines = [chalk`${pad}ext{gray :}`]

  for (const variable of variables) {
    const prefix = chalk`${bulletPad}{gray - }${variable.name}{gray :}`
    if (variable.type === 'data') {
      lines.push(
        chalk`${prefix} ${formatSnbt(variable.snbt)}{gray ,}`,
      )
    } else {
      lines.push(chalk`${prefix} {greenBright ${variable.return_value}}{gray ,}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

export function emitTestLog(
  payload: TestLogPayload,
  debug: DebugTraceContent | undefined,
  onEvent: TestEventSink,
): void {
  const merged: TestLogPayload = { ...payload, debug: true }
  if (debug !== undefined) merged.debug_trace = debug
  onEvent({ event: 'test_log', ...merged })
}

export function flushPendingLogs(state: CollectionState, onEvent: TestEventSink): void {
  for (const [, pending] of state.pendingLogs) {
    emitTestLog(pending.payload, undefined, onEvent)
  }
  state.pendingLogs.clear()
}

export async function startDebugWatcher(
  hostType: HostType,
  projectRoot: string,
  getExtras: (traceId: string) => LogExtra[] | undefined,
  onDebug: (debug: PendingDebug) => void,
  debugLog: DebugLog,
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
    if (body === '') return
    const firstNewLine = body.indexOf('\n')
    if (firstNewLine === -1) return
    const firstLine = body.slice(0, firstNewLine)
    const slash = firstLine.lastIndexOf('/')
    if (slash === -1) return
    const traceId = firstLine.slice(slash + 1).trim()
    const extras = getExtras(traceId)
    if (extras === undefined) return
    await fs.deleteFile(filePath).catch(() => {})
    onDebug({
      content: {
        trace: traceId,
        variables: parseDebugTrace(body, extras, debugLog),
      },
      filePath,
    })
  }

  const subscription = await subscribe(
    debugDir,
    (err, events) => {
      if (err !== null) return
      for (const event of events) {
        if (!event.path.endsWith('.txt')) continue
        if (event.type === 'create' || event.type === 'update') {
          ingestTraceFile(event.path)
        }
      }
    }
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
  onEvent: TestEventSink,
  _debugLog: DebugLog,
): boolean {
  const key = debug.content.trace as `${number}`
  const pendingLog = state.pendingLogs.get(key)
  if (pendingLog !== undefined) {
    state.pendingLogs.delete(key)
    void unlink(debug.filePath).catch(() => {})
    emitTestLog(pendingLog.payload, debug.content, onEvent)
    return true
  }
  state.pendingDebugs.set(key, debug)
  return false
}

export function pairLogLine(
  state: CollectionState,
  traceKey: `${number}`,
  payload: TestLogPayload,
  onEvent: TestEventSink,
  _debugLog: DebugLog,
): boolean {
  const pendingDebug = state.pendingDebugs.get(traceKey)
  if (pendingDebug !== undefined) {
    state.pendingDebugs.delete(traceKey)
    void unlink(pendingDebug.filePath).catch(() => {})
    emitTestLog(payload, pendingDebug.content, onEvent)
    return true
  }
  state.pendingLogs.set(traceKey, { payload })
  return false
}