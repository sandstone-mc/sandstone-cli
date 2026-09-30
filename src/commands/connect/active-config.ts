/**
 * Active `sandstone.config.ts` state held in memory by the daemon.
 *
 * The `sand watch` process is the source of truth for the project's
 * live saveConfig. It loads `sandstone.config.ts` on startup, watches
 * for changes, and pushes the current snapshot to the daemon over the
 * existing WebSocket connection (via the `publishConfig` RPC).
 *
 * The daemon caches the latest received snapshot and broadcasts a
 * `configChanged` event to all connected clients (notably `sand mcp`)
 * so they can refresh their resource contents in real time.
 *
 * Fallback for "no watcher running": the daemon loads the config from
 * disk itself at startup (`loadActiveConfigFromDisk`). It does NOT
 * watch the file.
 */

import { dirname, resolve } from 'node:path'
import { loadSandstoneConfig } from '../../utils/sandstoneConfig.js'
import { fileExists } from '../../utils/fs.js'
import type { ActiveSaveConfig } from '../../utils/activeSaveConfig.js'

export type ActiveMode = 'pack' | 'library'

/**
 * The live snapshot of `saveConfig`.
 * Watcher publishes this once it has applied all CLI/env overrides.
 */
export interface ActiveConfig {
  mode: ActiveMode
  configPath: string
  saveConfig?: ActiveSaveConfig
  /** Absolute path to the build output directory. */
  outputDir: string
  /** Absolute path to the watcher's log file (always at project root,
   *  not mode-dependent). */
  logPath: string
  /** Absolute path to the project root. */
  projectRoot: string
  /** ISO timestamp of when this snapshot was produced. */
  loadedAt: string
}

export async function resolveActiveMode(projectRoot: string): Promise<{ mode: ActiveMode; configPath: string } | null> {
  const packConfig = resolve(projectRoot, 'sandstone.config.ts')
  if (await fileExists(packConfig)) {
    return { mode: 'pack', configPath: packConfig }
  }
  const libConfig = resolve(projectRoot, 'test', 'sandstone.config.ts')
  if (await fileExists(libConfig)) {
    return { mode: 'library', configPath: libConfig }
  }
  return null
}

export function resolveOutputDir(projectRoot: string, mode: ActiveMode): string {
  return mode === 'pack'
    ? resolve(projectRoot, '.sandstone', 'output')
    : resolve(projectRoot, 'test', '.sandstone', 'output')
}

/**
 * Returns `undefined` when neither config file is found or when the
 * resolved file fails to parse.
 */
export async function loadActiveConfigFromDisk(projectRoot: string): Promise<ActiveConfig | undefined> {
  const resolved = await resolveActiveMode(projectRoot)
  if (!resolved) return undefined
  // `loadSandstoneConfig(cwd)` re-appends `sandstone.config.ts`, so we
  // pass the directory holding the config — for library mode that's
  // `<root>/test`, for pack mode `<root>`.
  const cfg = await loadSandstoneConfig(dirname(resolved.configPath))
  if (!cfg) return undefined

  return {
    mode: resolved.mode,
    configPath: resolved.configPath,
    // Boot-time fallback: no CLI flags reach the daemon, so the
    // config's `saveOptions` IS the active saveConfig. The watcher
    // may push a more-resolved snapshot later via `publishConfig`.
    saveConfig: (cfg.saveOptions ?? undefined) as ActiveSaveConfig | undefined,
    outputDir: resolveOutputDir(projectRoot, resolved.mode),
    logPath: resolve(projectRoot, '.sandstone', 'watch.log'),
    projectRoot,
    loadedAt: new Date().toISOString(),
  }
}