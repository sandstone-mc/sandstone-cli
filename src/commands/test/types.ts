import type { LogExtra } from 'sandstone/test'

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

export type TestLogPayload = Omit<Extract<TestEvent, { event: 'test_log' }>, 'event'>

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
  json?: boolean
}

export interface TestEntry {
  name: string
  description?: string
  optional?: boolean
  sourceFile?: string
  sourceLine?: number
  sourceColumn?: number
}

export interface ThrowableEntry {
  trace?: ErrorTrace
  command?: string
  line?: number
}

export interface TestsManifest {
  tests: TestEntry[]
  throwables: Record<string, ThrowableEntry>
  log_traces: Record<`${number}`, { server_trace: ErrorTrace; build_trace?: ErrorTrace; extras?: LogExtra[] }>
}

export interface CollectionState {
  collecting: boolean
  failed: Set<string>
  failedRecap: string[]
  optionalErrors: Set<string>
  pendingLogs: Map<`${number}`, PendingLog>
  pendingDebugs: Map<`${number}`, PendingDebug>
}

export interface PendingLog {
  payload: TestLogPayload
}

export interface PendingDebug {
  content: DebugTraceContent
  filePath: string
}

export interface DebugWatcher {
  ingest: (debug: PendingDebug) => void
  close: () => Promise<void>
}

export interface DebugTraceValue {
  command: string
  snbt?: string
  result?: string
}

export interface ErrorTrace {
  blame: string
  file: string
  line: number
  column?: number
}