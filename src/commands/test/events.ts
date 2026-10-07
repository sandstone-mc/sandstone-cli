import chalk from 'chalk-template'
import { formatDebugTraceValues } from './debug.js'
import { formatDiagnostic, formatMs, formatTestResult } from './format.js'
import type {
  DebugTraceValue,
  ErrorTrace,
  TestEntry,
  TestEvent,
  TestEventSink,
} from './types.js'

export function emitStatus(
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

export function emitError(message: string, onEvent: TestEventSink): void {
  onEvent({ event: 'error', message })
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