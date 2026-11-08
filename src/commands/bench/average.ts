import type { BenchBreakdownEntry, BenchMeasurement, BenchRun } from './types.js'

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stdDev(values: number[], average: number): number {
  if (values.length < 2) return 0
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export function averageRuns(runs: BenchRun[]): BenchMeasurement[] {
  if (runs.length === 0) return []

  const targetCount = runs[0]!.targets.length
  const averaged: BenchMeasurement[] = []

  for (let index = 0; index < targetCount; index++) {
    const first = runs[0]!.targets[index]!
    const samples = runs.map((run) => run.targets[index]!.msPerTick)
    const msPerTick = mean(samples)

    const byName = new Map<string, BenchBreakdownEntry[]>()
    for (const run of runs) {
      for (const entry of run.targets[index]!.breakdown) {
        const list = byName.get(entry.name)
        if (list) {
          list.push(entry)
        } else {
          byName.set(entry.name, [entry])
        }
      }
    }

    const breakdown = [...byName.entries()]
      .map(([name, entries]) => ({
        name,
        count: Math.round(mean(entries.map((entry) => entry.count))),
        msPerTick: mean(entries.map((entry) => entry.msPerTick)),
        percentage: mean(entries.map((entry) => entry.percentage)),
      }))
      .sort((left, right) => right.msPerTick - left.msPerTick)

    averaged.push({
      label: first.label,
      function: first.function,
      iterationsPerTick: first.iterationsPerTick,
      msPerTick,
      msPerTickStdDev: stdDev(samples, msPerTick),
      msPerTickMin: Math.min(...samples),
      msPerTickMax: Math.max(...samples),
      samples,
      globalPercentage: mean(runs.map((run) => run.targets[index]!.globalPercentage)),
      commandMsPerTick: mean(runs.map((run) => run.targets[index]!.commandMsPerTick)),
      commandPercentage: mean(runs.map((run) => run.targets[index]!.commandPercentage)),
      overheadMsPerTick: mean(runs.map((run) => run.targets[index]!.overheadMsPerTick)),
      overheadPercentage: mean(runs.map((run) => run.targets[index]!.overheadPercentage)),
      breakdown,
    })
  }

  return averaged
}
