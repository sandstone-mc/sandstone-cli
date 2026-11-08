export type BenchTargetSpec = string | {
  /** Namespaced id of the mcfunction to benchmark, e.g. `mypack:my_function`. */
  function: string
  /** How many times per tick the function is called. Overrides the file-level default. */
  iterationsPerTick?: number
}

export interface BenchConfigFile {
  a: BenchTargetSpec
  b: BenchTargetSpec
  /** Default number of calls per tick, applied to both targets. */
  iterationsPerTick?: number
  /** Optional mcfunction run once before the measured window. */
  setup?: string
  /** Optional mcfunction run once after the measured window. */
  cleanup?: string
}

export interface BenchPlan {
  /** The two sides of the comparison. */
  targets: BenchTarget[]
  /** Optional mcfunction run once before the measured window. */
  setup?: string
  /** Optional mcfunction run once after the measured window. */
  cleanup?: string
}

export interface BenchTarget {
  label: 'a' | 'b'
  /** Namespaced id of the mcfunction under test. */
  function: string
  /** How many times per tick the function is called. */
  iterationsPerTick: number
}

export interface BenchBreakdownEntry {
  /** The profiler's section name, e.g. `execute scoreboard players add ...`. */
  name: string
  /** How many times the section was entered across the whole profile. */
  count: number
  /** Time attributed to the section, in milliseconds per tick. */
  msPerTick: number
  /** Share of the measured function's inclusive time, as a percentage. */
  percentage: number
}

export interface BenchMeasurement {
  label: 'a' | 'b'
  /** Namespaced id of the mcfunction under test. */
  function: string
  /** How many times per tick the function was called. */
  iterationsPerTick: number
  /** Inclusive time of the whole wrapper function, in milliseconds per tick (mean over the runs). */
  msPerTick: number
  /** Sample standard deviation of `msPerTick` across the runs. 0 for a single run. */
  msPerTickStdDev: number
  /** The lowest `msPerTick` observed across the runs. */
  msPerTickMin: number
  /** The highest `msPerTick` observed across the runs. */
  msPerTickMax: number
  /** The individual per-run values of `msPerTick`, in run order. */
  samples: number[]
  /** The same value as a percentage of the entire profiling window. */
  globalPercentage: number
  /** Time spent inside the function's own commands, in milliseconds per tick. */
  commandMsPerTick: number
  /** Share of the function's inclusive time spent in its own commands, as a percentage. */
  commandPercentage: number
  /**
   * Time inside the wrapper that isn't attributed to any command section —
   * the cost of dispatching the function calls themselves.
   */
  overheadMsPerTick: number
  /** Share of the function's inclusive time spent on call dispatch, as a percentage. */
  overheadPercentage: number
  /** The heaviest command sections inside the function, biggest first. */
  breakdown: BenchBreakdownEntry[]
}

export interface BenchRun {
  /** 0-based index of the run. */
  index: number
  /** Length of the profiling window, in milliseconds. */
  timeSpanMs: number
  /** How many server ticks the profiling window covered. */
  tickSpan: number
  /** Path of the profiling archive, relative to the server directory. */
  profilePath: string
  /** One measurement per target, in `a` / `b` order. */
  targets: BenchMeasurement[]
}

export interface BenchResult {
  /** Mean length of the profiling window, in milliseconds. */
  timeSpanMs: number
  /** Mean number of server ticks the profiling window covered. */
  tickSpan: number
  /** How many profiling runs were averaged. */
  runCount: number
  /** The profiling archives the numbers came from, relative to the server directory. */
  profilePaths: string[]
  /** One averaged measurement per target, in `a` / `b` order. */
  targets: BenchMeasurement[]
  /** The individual runs, in order. */
  runs: BenchRun[]
  /** Where the JSON report was written, relative to the project root. */
  reportPath: string
}

export class BenchConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BenchConfigError'
  }
}

export type BenchEvent = (
  | {
    event: 'status',
    message: string,
    /** A machine-readable label for the step, e.g. `profiling`. */
    type?: string,
    /** 1-based index of the profiling run, when the status belongs to one. */
    run?: number,
    /** How many profiling runs there are in total. */
    runs?: number,
  }
  | {
    event: 'error',
    message: string,
  }
  | {
    event: 'result',
    /** The averaged numbers, in the same shape as the saved JSON report. */
    result: BenchResult,
  }
)

export type BenchEventSink = (event: BenchEvent) => void
