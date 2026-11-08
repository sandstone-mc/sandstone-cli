import type { BenchTarget } from './types.js'

export const BENCH_NAMESPACE = 'sandstone_bench'

export const BENCH_PACK_DIR = `world/datapacks/${BENCH_NAMESPACE}`

export const BENCH_PACK_FORMAT = 121

export interface BenchPackFile {
  path: string
  content: string
}

export function wrapperFunctionId(label: 'a' | 'b'): string {
  return `${BENCH_NAMESPACE}:${label}`
}

export function buildBenchPack(targets: BenchTarget[]): BenchPackFile[] {
  const files: BenchPackFile[] = []

  files.push({
    path: `${BENCH_PACK_DIR}/pack.mcmeta`,
    content: `${JSON.stringify({
      pack: {
        min_format: BENCH_PACK_FORMAT,
        max_format: BENCH_PACK_FORMAT,
        description: 'Sandstone benchmark harness',
      },
    }, null, 2)}\n`,
  })

  files.push({
    path: `${BENCH_PACK_DIR}/data/minecraft/tags/function/tick.json`,
    content: `${JSON.stringify({
      values: targets.map((target) => wrapperFunctionId(target.label)),
    }, null, 2)}\n`,
  })

  for (const target of targets) {
    const body = Array.from(
      { length: target.iterationsPerTick },
      () => `function ${target.function}`,
    ).join('\n')

    files.push({
      path: `${BENCH_PACK_DIR}/data/${BENCH_NAMESPACE}/function/${target.label}.mcfunction`,
      content: `${body}\n`,
    })
  }

  return files
}

export function buildBenchPackDisableFiles(targets: BenchTarget[]): BenchPackFile[] {
  const files: BenchPackFile[] = [{
    path: `${BENCH_PACK_DIR}/data/minecraft/tags/function/tick.json`,
    content: `${JSON.stringify({ values: [] }, null, 2)}\n`,
  }]

  for (const target of targets) {
    files.push({
      path: `${BENCH_PACK_DIR}/data/${BENCH_NAMESPACE}/function/${target.label}.mcfunction`,
      content: '',
    })
  }

  return files
}
