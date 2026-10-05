declare var self: Worker

import { stripCliFrames } from './utils/strip-cli-frames.js'
import type {
  BuildResultPayload,
  ModShape,
  WorkerLevel,
  WorkerRequest,
  WorkerResponse,
} from './commands/build/worker-types.js'

function postMessage(msg: WorkerResponse, opts?: Bun.StructuredSerializeOptions) {
  return self.postMessage(msg, opts)
}

const stripCliFramesWrapped = (s: string): string =>
  stripCliFrames(
    (s || '')
      .replace(/^Error\n/, '')
      .replace(/\?hot-hook=\d+/g, '')
      .replace(/file:\/\/\/?/g, ''),
  )

const cleanStack = (s: string | null | undefined): string =>
  stripCliFramesWrapped(s || '')

const serialize = (level: WorkerLevel, args: unknown[]): string => {
  try {
    return args
      .map((a) => {
        if (typeof a === 'string') return a
        if (a && typeof a === 'object' && 'stack' in a && typeof (a as { stack: unknown }).stack === 'string') {
          return level === 'trace' || level === 'debug' ? cleanStack((a as { stack: string }).stack) : (a as { stack: string }).stack
        }
        return JSON.stringify(a)
      })
      .join(' ')
  } catch (_e) {
    return String(args)
  }
}

const levels: WorkerLevel[] = ['log', 'info', 'warn', 'error', 'debug', 'trace']
for (const level of levels) {
  const fn = console[level]
  if (typeof fn === 'function') {
    console[level] = (...args: unknown[]) => {
      try { postMessage({ __log: { level, line: serialize(level, args) } }) } catch (_e) {}
    }
  }
}

self.onerror = (event: { message: string, filename: string, lineno: number, colno: number }) => {
  try { postMessage({ __log: { level: 'error', line: `onerror: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}` } }) } catch (_e) {}
  return false
}

/* @ts-ignore */ // TODO: Broken Bun Types, ignore this for now
self.addEventListener(
  /* @ts-ignore */
  'unhandledrejection',
  /* @ts-ignore */
  (event: { reason: unknown }) => {
    try { postMessage({ __log: { level: 'error', line: 'unhandledrejection: ' + String(event.reason) } }) } catch (_e) {}
  }
)

let storedBuildContext: unknown = undefined

self.onmessage = async (event: { data: WorkerRequest }) => {
  const data = event.data
  const id = data.id
  const entryPath = data.entryPath
  const optsJson = data.optsJson
  const folder = data.folder
  const watching = data.watching
  const resolvedFolder = data.resolvedFolder || ''
  const resolvedRoot = data.resolvedRoot || ''
  const lastBuildFailed = !!data.lastBuildFailed

  try {
    let cleared = 0
    const cache = (typeof require !== 'undefined' && require.cache) ? require.cache : null
    if (cache) {
      for (const key in cache) {
        const nk = String(key).replace(/\\/g, '/')
        if (resolvedFolder && nk.indexOf(resolvedFolder) !== 0 && nk.indexOf(resolvedRoot) !== 0) continue
        if (nk.indexOf('/node_modules/sandstone/') !== -1) continue
        delete cache[key]
        cleared++
      }
    }
    if (cleared === 0 && lastBuildFailed) {
      postMessage({ id, __needsRestart: true, reason: 'parse error - cant recover when no modules were cached' })
      return
    }
    const mod = (await import(entryPath)) as unknown as ModShape
    const opts = JSON.parse(optsJson) as unknown
    const result = await mod._buildCommand(opts, folder, storedBuildContext, watching)
    if (result && result.success && result.sandstoneConfig) {
      storedBuildContext = {
        sandstoneConfig: result.sandstoneConfig,
        sandstonePack: result.sandstonePack,
        resetSandstonePack: result.resetSandstonePack,
      }
    } else {
      storedBuildContext = undefined
    }
    const wireResult: BuildResultPayload = {
      success: result.success,
      error: result.error,
      resourceCounts: result.resourceCounts,
      timestamp: result.timestamp,
      sandstoneConfig: result.sandstoneConfig,
      activeSaveConfig: result.activeSaveConfig,
      hasTests: !!result.sandstonePack?.Test?.tests?.size,
    }
    postMessage({ id, ok: true, result: wireResult })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = cleanStack(err instanceof Error ? err.stack : null)
    postMessage({ id, __error: msg + '\n' + stack })
  }
}