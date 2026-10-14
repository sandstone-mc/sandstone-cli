/**
 * Build the `TestsManifest` JSON document that `sand test` reads back at
 * runtime to resolve test names → build metadata, throwables → stack
 * traces, and log traces → SNBT extras.
 *
 * Pulled out of `commands/build/index.ts` so external test drivers (e.g.
 * the integrated test harness in `sandstone/tests/integrated/__setup.ts`)
 * can produce the same manifest shape without spawning a second `sand build`.
 */

import type { SandstonePack } from 'sandstone'
import type { TestEntry, TestsManifest, ThrowableEntry } from './types.js'

interface TestResource {
  name: string
  description?: string
  directives?: { optional?: boolean }
  sourceFile?: string
  sourceLine?: number
  sourceColumn?: number
  throwableStack?: Map<string, ThrowableEntry>
}

export function buildTestManifest(pack: SandstonePack): TestsManifest {
  const tests: TestEntry[] = []
  const throwables: Record<string, ThrowableEntry> = {}

  pack.Test.tests.forEach((node) => {
    const resource = (node as unknown as { resource?: TestResource }).resource
    if (!resource) return
    const entry: TestEntry = { name: resource.name }
    if (resource.description !== undefined) entry.description = resource.description
    if (resource.directives?.optional !== undefined) entry.optional = resource.directives.optional
    if (resource.sourceFile !== undefined) entry.sourceFile = resource.sourceFile
    if (resource.sourceLine !== undefined) entry.sourceLine = resource.sourceLine
    if (resource.sourceColumn !== undefined) entry.sourceColumn = resource.sourceColumn
    tests.push(entry)
    if (resource.throwableStack) {
      for (const [key, value] of resource.throwableStack.entries()) {
        throwables[key] = value
      }
    }
  })

  const log_traces: TestsManifest['log_traces'] = {}
  for (const [id, trace] of pack.Test.logTraces.entries()) {
    log_traces[id as `${number}`] = trace as TestsManifest['log_traces'][`${number}`]
  }
  return { tests, throwables, log_traces }
}
