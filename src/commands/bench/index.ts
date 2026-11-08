import * as path from 'path'
import { logger } from '../../utils/logger.js'
import { emitError, renderBenchEvent } from './events.js'
import { benchResultToJson, formatBenchResult } from './format.js'
import { runBench, type BenchCommandOptions } from './runner.js'
import { BenchConfigError, type BenchEventSink } from './types.js'

export type { BenchCommandOptions } from './runner.js'
export type {
  BenchBreakdownEntry,
  BenchEvent,
  BenchEventSink,
  BenchMeasurement,
  BenchResult,
  BenchRun,
  BenchTarget,
} from './types.js'
export { runBench } from './runner.js'

export async function benchCommand(opts: BenchCommandOptions): Promise<void> {
  const json = opts.json === true

  const closeBenchLog = logger.registerSink('bench', path.join(opts.path, '.sandstone', 'bench.log'), 'Bench')
  logger.sinks.bench.setLiveCallback((_level, args) => {
    const line = args
      .map((a) =>
        typeof a === 'string' ? a
        : Array.isArray(a) ? a.join('')
        : String(a)
      )
      .join(' ')
    console.log(line)
  })

  const logInfo = logger.sinks.bench.logInfo
  const sink: BenchEventSink = json
    ? (event) => { logInfo(JSON.stringify(event)) }
    : (event) => { for (const line of renderBenchEvent(event)) logInfo(line) }

  let exitCode = 0

  try {
    const result = await runBench(opts, sink)

    if (json) {
      logInfo(JSON.stringify({ event: 'result', result: benchResultToJson(result) }))
    } else {
      for (const line of formatBenchResult(result).split('\n')) logInfo(line)
    }
  } catch (err) {
    emitError(err instanceof Error ? err.message : String(err), sink)
    exitCode = err instanceof BenchConfigError ? 2 : 1
  } finally {
    await closeBenchLog()
  }

  if (exitCode !== 0) process.exit(exitCode)
}
