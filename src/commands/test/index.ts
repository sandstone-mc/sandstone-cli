import * as path from 'path'
import { logger } from '../../utils/logger.js'
import { printSplash } from '../../utils/index.js'
import { renderTestEvent } from './events.js'
import { runTests } from './runner.js'
import type { TestCommandOptions, TestEventSink } from './types.js'

export type { TestCommandOptions, TestEvent, TestEventSink } from './types.js'
export { runTests } from './runner.js'
export { renderTestEvent } from './events.js'

export async function testCommand(opts: TestCommandOptions): Promise<void> {
  const json = opts.json === true
  if (!json) printSplash()
  const closeTestLog = logger.registerSink('test', path.join(opts.path, '.sandstone', 'test.log'), 'Test')
  logger.sinks.test.setLiveCallback((_level, args) => {
    const line = args
      .map((a) =>
        typeof a === 'string' ? a
        : Array.isArray(a) ? a.join('')
        : String(a)
      )
      .join(' ')
    console.log(line)
  })
  const logInfo = logger.sinks.test.logInfo
  const sink: TestEventSink = json
    ? (e) => { logInfo(JSON.stringify(e)) }
    : (e) => { for (const line of renderTestEvent(e)) logInfo(line) }
  try {
    process.exit(await runTests(opts, undefined, sink))
  } finally {
    await closeTestLog()
  }
}