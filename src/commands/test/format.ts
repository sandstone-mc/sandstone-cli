import * as path from 'path'
import chalk from 'chalk-template'
import type { ErrorTrace, TestEntry } from './types.js'

export function formatTestResult(
  entry: TestEntry | undefined,
  source: string,
  passed: boolean,
  optional: boolean,
  tick: number | null,
): string {
  let header = ''
  header += passed ? chalk`{green ✔} ` : chalk`{red ✗} `
  header += chalk`{yellowBright ${source}}`
  if (optional) header += chalk` {gray (optional)}`
  header += chalk` {gray >} `
  header += entry?.description ? chalk`{bold ${entry.description}}` : '(no description)'
  if (tick !== null) header += chalk` {gray [${tick}t]}`
  return header
}

export function formatDiagnostic(
  message: string,
  stackTrace: ErrorTrace[],
  options?: {
    keyword?: string,
    keywordColor?: string,
    position?: [number, number, number],
    footer?: string,
  }
): string {
  const keyword = options?.keyword ?? 'error'
  let out = ''
  out += chalk`\n{${options?.keywordColor ?? 'red'} ${keyword}}{gray :} {bold ${message}}`
  if (options?.position !== undefined) {
    const [ x, y, z ] = options.position
    out += chalk`\n  pos{gray :} {greenBright ${x} ${y} ${z}}{gray ,}\n`
  }
  for (const trace of stackTrace) {
    let frame = chalk`\n${' '.repeat(6)}{gray at} {bold {italic ${trace.blame ?? '<anonymous>'}}} `
    if (trace.file !== undefined) {
      frame += chalk`{gray (}`
      const cwd = process.cwd()
      const datapackOutput = path.join(cwd, '.sandstone', 'output', 'datapack', 'data')
      if (trace.file.startsWith(datapackOutput)) {
        frame += chalk`{blue ${datapackOutput}${path.sep}}{cyan ${trace.file.slice(datapackOutput.length + 1)}}`
      } else if (trace.file.startsWith(cwd)) {
        frame += chalk`{blue ${cwd}${path.sep}}{cyan ${trace.file.slice(cwd.length + 1)}}`
      } else {
        frame += chalk`{cyan ${trace.file}}`
      }
      frame += chalk`{gray :}`
      if (trace.line !== undefined) frame += chalk`{yellowBright ${trace.line}}`
      frame += chalk`{gray :}{yellow ${trace.column ?? 0}}{gray )}`
    }
    out += frame
  }
  if (options?.footer !== undefined) out += `\n${options.footer}`
  return out
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(2)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}