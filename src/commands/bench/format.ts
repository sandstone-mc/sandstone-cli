import chalk from 'chalk-template'
import type { BenchMeasurement, BenchResult } from './types.js'

const MAX_BREAKDOWN_ROWS = 5

function formatMs(value: number): string {
  if (value === 0) return '0.000'
  if (value < 0.001) return value.toExponential(2)
  return value.toFixed(3)
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function indent(value: string): string {
  return `    ${value}`
}

function formatTargetLine(target: BenchMeasurement, runCount: number): string {
  const spread = runCount > 1 ? chalk` {dim ±${formatMs(target.msPerTickStdDev)}}` : ''
  return chalk`  {bold ${target.label.toUpperCase()}}  {cyan ${target.function}}  {dim ${target.iterationsPerTick} calls/tick}  {bold ${formatMs(target.msPerTick)}} ms/tick${spread}  {dim (${target.globalPercentage.toFixed(2)}% of window)}`
}

function formatBreakdown(target: BenchMeasurement): string[] {
  const lines: string[] = []

  lines.push(indent(chalk`commands       {bold ${formatMs(target.commandMsPerTick)}} ms/tick  {dim (${target.commandPercentage.toFixed(1)}%)}`))
  lines.push(indent(chalk`call overhead  {bold ${formatMs(target.overheadMsPerTick)}} ms/tick  {dim (${target.overheadPercentage.toFixed(1)}%)}`))

  for (const entry of target.breakdown.slice(0, MAX_BREAKDOWN_ROWS)) {
    lines.push(indent(chalk`{dim ${truncate(entry.name, 52)}}`))
    lines.push(indent(chalk`{dim ${formatMs(entry.msPerTick)} ms/tick · ${entry.count} calls}`))
  }

  return lines
}

function formatComparison(a: BenchMeasurement, b: BenchMeasurement): string {
  if (a.msPerTick === b.msPerTick) {
    return chalk`  {dim The two targets took the same time.}`
  }

  const slower = a.msPerTick > b.msPerTick ? a : b
  const faster = slower === a ? b : a
  const ratio = slower.msPerTick / faster.msPerTick
  const delta = slower.msPerTick - faster.msPerTick

  return chalk`  → {bold ${slower.label.toUpperCase()}} is {bold ${ratio.toFixed(2)}×} slower than {bold ${faster.label.toUpperCase()}}`
    + chalk` {dim (+${formatMs(delta)} ms/tick)}`
}

function formatSamples(result: BenchResult): string[] {
  if (result.runCount < 2) return []

  const lines: string[] = ['  Per-run ms/tick:']
  for (const target of result.targets) {
    const samples = target.samples.map((sample) => formatMs(sample)).join(', ')
    lines.push(indent(chalk`{bold ${target.label.toUpperCase()}}  {dim ${samples}}`))
  }
  return lines
}

export function formatBenchResult(result: BenchResult): string {
  const lines: string[] = []

  const header = result.runCount > 1
    ? chalk`{bold Bench results} {dim — mean of ${result.runCount} runs, ${result.tickSpan.toFixed(0)} ticks over ${(result.timeSpanMs / 1000).toFixed(2)} s each}`
    : chalk`{bold Bench results} {dim — ${result.tickSpan} ticks over ${(result.timeSpanMs / 1000).toFixed(2)} s}`
  lines.push(header)
  lines.push('')

  for (const target of result.targets) {
    lines.push(formatTargetLine(target, result.runCount))
  }

  lines.push('')
  const [a, b] = result.targets
  if (a && b) lines.push(formatComparison(a, b))
  lines.push('')

  lines.push(...formatSamples(result))
  if (result.runCount > 1) lines.push('')

  for (const target of result.targets) {
    lines.push(chalk`  {bold ${target.label.toUpperCase()}} {cyan ${target.function}}`)
    lines.push(...formatBreakdown(target))
    lines.push('')
  }

  lines.push(chalk`  {dim Profile: ${result.profilePaths.join(', ')}}`)
  lines.push(chalk`  {dim Report:  ${result.reportPath}}`)

  return lines.join('\n')
}

export function benchResultToJson(result: BenchResult) {
  return {
    time_span_ms: result.timeSpanMs,
    tick_span: result.tickSpan,
    run_count: result.runCount,
    profile_paths: result.profilePaths,
    report_path: result.reportPath,
    targets: result.targets.map((target) => ({
      label: target.label,
      function: target.function,
      iterations_per_tick: target.iterationsPerTick,
      ms_per_tick: target.msPerTick,
      ms_per_tick_stddev: target.msPerTickStdDev,
      ms_per_tick_min: target.msPerTickMin,
      ms_per_tick_max: target.msPerTickMax,
      samples: target.samples,
      global_percentage: target.globalPercentage,
      command_ms_per_tick: target.commandMsPerTick,
      command_percentage: target.commandPercentage,
      overhead_ms_per_tick: target.overheadMsPerTick,
      overhead_percentage: target.overheadPercentage,
      breakdown: target.breakdown.map((entry) => ({
        name: entry.name,
        count: entry.count,
        ms_per_tick: entry.msPerTick,
        percentage: entry.percentage,
      })),
    })),
    runs: result.runs.map((run) => ({
      index: run.index,
      time_span_ms: run.timeSpanMs,
      tick_span: run.tickSpan,
      profile_path: run.profilePath,
      targets: run.targets.map((target) => ({
        label: target.label,
        function: target.function,
        ms_per_tick: target.msPerTick,
        global_percentage: target.globalPercentage,
        command_ms_per_tick: target.commandMsPerTick,
        overhead_ms_per_tick: target.overheadMsPerTick,
      })),
    })),
  }
}
