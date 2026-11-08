import type { BenchConfigFile, BenchPlan, BenchTarget, BenchTargetSpec } from './types.js'
import { BenchConfigError } from './types.js'

const NAMESPACE_PATTERN = /^[a-z0-9._-]+$/
const PATH_PATTERN = /^[a-z0-9._/-]+$/

const MAX_ITERATIONS_PER_TICK = 10_000

const DEFAULT_ITERATIONS_PER_TICK = 1

function isPlainObject(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFunctionId(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BenchConfigError(`Target "${label}" must name a function, e.g. "mypack:my_function".`)
  }

  const separator = raw.indexOf(':')
  if (separator <= 0 || separator === raw.length - 1) {
    throw new BenchConfigError(
      `Target "${label}" must be a namespaced id ("namespace:function"), got "${raw}".`,
    )
  }

  const namespace = raw.slice(0, separator)
  const path = raw.slice(separator + 1)

  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new BenchConfigError(
      `Target "${label}" has an invalid namespace "${namespace}" — expected lowercase letters, digits, ".", "_" or "-".`,
    )
  }
  if (!PATH_PATTERN.test(path)) {
    throw new BenchConfigError(
      `Target "${label}" has an invalid function path "${path}" — expected lowercase letters, digits, ".", "_", "-" or "/".`,
    )
  }

  return `${namespace}:${path}`
}

function parseIterations(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new BenchConfigError(
      `Target "${label}" has an invalid "iterationsPerTick" (${JSON.stringify(raw)}) — expected a positive integer.`,
    )
  }
  if (raw > MAX_ITERATIONS_PER_TICK) {
    throw new BenchConfigError(
      `Target "${label}" asks for ${raw} iterations per tick, which is above the ${MAX_ITERATIONS_PER_TICK} limit.`,
    )
  }
  return raw
}

function parseTarget(
  label: 'a' | 'b',
  spec: BenchTargetSpec | undefined,
  defaultIterations: number,
): BenchTarget {
  if (spec === undefined) {
    throw new BenchConfigError(`The config file is missing target "${label}".`)
  }

  if (typeof spec === 'string') {
    return {
      label,
      function: parseFunctionId(spec, label),
      iterationsPerTick: defaultIterations,
    }
  }

  if (!isPlainObject(spec)) {
    throw new BenchConfigError(`Target "${label}" must be a string or an object.`)
  }

  const iterations = spec.iterationsPerTick === undefined
    ? defaultIterations
    : parseIterations(spec.iterationsPerTick, label)

  return {
    label,
    function: parseFunctionId(spec.function, label),
    iterationsPerTick: iterations,
  }
}

export function parseBenchConfig(raw: unknown, iterationOverride?: number): BenchPlan {
  if (!isPlainObject(raw)) {
    throw new BenchConfigError('The config file must contain a JSON object.')
  }

  const file = raw as BenchConfigFile
  const knownKeys = ['a', 'b', 'iterationsPerTick', 'setup', 'cleanup']
  const unknownKeys = Object.keys(file).filter((key) => !knownKeys.includes(key))
  if (unknownKeys.length > 0) {
    throw new BenchConfigError(
      `Unknown key(s) in the config file: ${unknownKeys.map((k) => `"${k}"`).join(', ')}. Expected ${knownKeys.map((k) => `"${k}"`).join(', ')}.`,
    )
  }

  let defaultIterations = DEFAULT_ITERATIONS_PER_TICK
  if (file.iterationsPerTick !== undefined) {
    defaultIterations = parseIterations(file.iterationsPerTick, 'iterationsPerTick')
  }
  if (iterationOverride !== undefined) {
    defaultIterations = parseIterations(iterationOverride, '--iterations')
  }

  const plan: BenchPlan = {
    targets: [
      parseTarget('a', file.a, defaultIterations),
      parseTarget('b', file.b, defaultIterations),
    ],
  }

  if (file.setup !== undefined) {
    plan.setup = parseFunctionId(file.setup, 'setup')
  }
  if (file.cleanup !== undefined) {
    plan.cleanup = parseFunctionId(file.cleanup, 'cleanup')
  }

  return plan
}

export async function readBenchConfigFile(configPath: string): Promise<unknown> {
  let text: string
  try {
    text = await Bun.file(configPath).text()
  } catch (err) {
    throw new BenchConfigError(
      `Cannot read the bench config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  try {
    return JSON.parse(text)
  } catch (err) {
    throw new BenchConfigError(
      `The bench config at ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
