import { wrapperFunctionId } from './datapack.js'
import type { BenchBreakdownEntry, BenchMeasurement, BenchTarget } from './types.js'

/** One node of Minecraft's tick-profiler tree. */
export interface ProfileNode {
  /** Nesting depth, 0 for the root's direct children. */
  depth: number
  /** The section name, e.g. `function mypack:my_function`. */
  name: string
  /** How many times the section was entered over the whole profile. */
  count: number
  /** How many times the section was entered per tick. */
  perTick: number
  /** Share of the parent's total time, as a percentage. */
  percentage: number
  /** Share of the whole profile's time, as a percentage. */
  globalPercentage: number
  children: ProfileNode[]
}

/** The parsed `server/profiling.txt` from a profiling archive. */
export interface ProfileDump {
  version: string
  /** Length of the profiling window, in milliseconds. */
  timeSpanMs: number
  /** How many server ticks the window covered. */
  tickSpan: number
  root: ProfileNode
}

const HEADER_VERSION = /^Version:\s*(.+)$/
const HEADER_TIME_SPAN = /^Time span:\s*(\d+)\s*ms$/
const HEADER_TICK_SPAN = /^Tick span:\s*(\d+)\s*ticks$/

const DUMP_BEGIN = '--- BEGIN PROFILE DUMP ---'
const DUMP_END = '--- END PROFILE DUMP ---'

/**
 * `[01] |   name(count/perTick) - 12.34%/5.67%`
 *
 * The name is matched greedily so that a section name containing parentheses
 * (a command's own text, for instance) is not mistaken for the count pair.
 */
const NODE_LINE = /^\[(\d{2})\] ((?:\|   )*)(.+)\((\d+)\/(\d+)\) - (\d+(?:\.\d+)?)%\/(\d+(?:\.\d+)?)%$/

/** The synthetic node Minecraft uses for time that isn't attributed to a child. */
const UNSPECIFIED = 'unspecified'

function makeNode(
  depth: number,
  name: string,
  count: number,
  perTick: number,
  percentage: number,
  globalPercentage: number,
): ProfileNode {
  return { depth, name, count, perTick, percentage, globalPercentage, children: [] }
}

/**
 * Parse the text of a `server/profiling.txt`.
 *
 * The tree is printed as a flat, depth-annotated list, so it is rebuilt by
 * keeping a stack of the most recent node at each depth.
 */
export function parseProfileDump(text: string): ProfileDump {
  const lines = text.split(/\r?\n/)

  let version = ''
  let timeSpanMs = 0
  let tickSpan = 0

  for (const line of lines) {
    const versionMatch = HEADER_VERSION.exec(line)
    if (versionMatch) {
      version = versionMatch[1]!.trim()
      continue
    }
    const timeMatch = HEADER_TIME_SPAN.exec(line)
    if (timeMatch) {
      timeSpanMs = Number(timeMatch[1])
      continue
    }
    const tickMatch = HEADER_TICK_SPAN.exec(line)
    if (tickMatch) {
      tickSpan = Number(tickMatch[1])
      continue
    }
  }

  if (timeSpanMs <= 0 || tickSpan <= 0) {
    throw new Error('The profiling report is missing its "Time span" / "Tick span" header.')
  }

  const root = makeNode(-1, 'root', 0, 0, 100, 100)
  const stack: ProfileNode[] = [root]

  let insideDump = false
  for (const line of lines) {
    if (line.trim() === DUMP_BEGIN) {
      insideDump = true
      continue
    }
    if (line.trim() === DUMP_END) {
      insideDump = false
      continue
    }
    if (!insideDump) continue

    const match = NODE_LINE.exec(line)
    if (!match) continue

    const depth = Number(match[1])
    const name = match[3]!.trim()
    const node = makeNode(
      depth,
      name,
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7]),
    )

    stack.length = depth + 1
    const parent = stack[depth]
    if (!parent) continue
    parent.children.push(node)
    stack.push(node)
  }

  return { version, timeSpanMs, tickSpan, root }
}

/** Depth-first search for a node with an exact name. */
export function findNode(root: ProfileNode, name: string): ProfileNode | undefined {
  if (root.name === name) return root
  for (const child of root.children) {
    const found = findNode(child, name)
    if (found) return found
  }
  return undefined
}

/**
 * Convert a node's share of the whole profile into milliseconds per tick.
 *
 * The profiler reports every node as a percentage of the root's total time,
 * and the root covers roughly the whole profiling window.
 */
export function msPerTick(node: ProfileNode, dump: ProfileDump): number {
  return (node.globalPercentage / 100) * dump.timeSpanMs / dump.tickSpan
}

/**
 * Pull the measurement for each target out of the parsed tree.
 *
 * Each target's wrapper function is looked up by name.
 */
export function measureTargets(dump: ProfileDump, targets: BenchTarget[]): BenchMeasurement[] {
  return targets.map((target) => {
    const wrapper = wrapperFunctionId(target.label)
    const node = findNode(dump.root, `function ${wrapper}`)

    if (!node) {
      throw new Error(
        `The profiling report has no "function ${wrapper}" section — `
        + `the benchmark wrapper for "${target.function}" did not run. Check that the function exists and that the datapack loaded.`,
      )
    }

    const total = msPerTick(node, dump)

    let overheadMsPerTick = 0
    let overheadPercentage = 0
    const breakdown: BenchBreakdownEntry[] = []

    for (const child of node.children) {
      if (child.name === UNSPECIFIED) {
        overheadMsPerTick = msPerTick(child, dump)
        overheadPercentage = child.percentage
        continue
      }
      breakdown.push({
        name: child.name,
        count: child.count,
        msPerTick: msPerTick(child, dump),
        percentage: child.percentage,
      })
    }

    breakdown.sort((left, right) => right.msPerTick - left.msPerTick)

    // The command time is the sum of the command sections rather than
    // `total - overhead`: the profiler rounds every percentage to two
    // decimals, so subtracting two rounded numbers drifts further than
    // adding up the sections themselves.
    const commandMsPerTick = breakdown.reduce((sum, entry) => sum + entry.msPerTick, 0)

    // A child's `percentage` is its share of its parent, so the command
    // sections' percentages already add up against the function node.
    const commandPercentage = breakdown.reduce((sum, entry) => sum + entry.percentage, 0)

    return {
      label: target.label,
      function: target.function,
      iterationsPerTick: target.iterationsPerTick,
      msPerTick: total,
      // A single run has no spread to report; the averaging pass fills these
      // in once every run has been measured.
      msPerTickStdDev: 0,
      msPerTickMin: total,
      msPerTickMax: total,
      samples: [total],
      globalPercentage: node.globalPercentage,
      commandMsPerTick,
      commandPercentage,
      overheadMsPerTick,
      overheadPercentage,
      breakdown,
    }
  })
}
