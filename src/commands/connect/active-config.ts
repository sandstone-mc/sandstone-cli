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
 * watch the file — the daemon's role is to be a passive hub, not to
 * duplicate the watcher's filesystem work.
 *
 * Why live WS (not a file or DB)?
 *   - Real-time: edits propagate to every connected client within
 *     milliseconds of the watcher detecting them.
 *   - Atomic: single in-memory state — no torn reads, no rename
 *     dance.
 *   - Existing connection: `sand watch` already keeps a WS open to
 *     `sand connect` (see watch.ts → attachLog over the connect
 *     daemon). We piggy-back on that connection rather than introducing
 *     a side-channel file.
 *   - Daemon restart is fine: it re-loads from disk at boot. The
 *     watcher reconnects within seconds (it watches `connect.url` for
 *     the endpoint file) and re-pushes.
 */

import { dirname, resolve } from 'node:path'
import { loadSandstoneConfig } from '../../utils/sandstoneConfig.js'
import { fileExists } from '../../utils/fs.js'
import type { ActiveSaveConfig } from '../../utils/activeSaveConfig.js'

export type ActiveMode = 'pack' | 'library'

/**
 * The live snapshot. `saveConfig` is the resolved deploy config (world,
 * client/server paths, root install) — NOT the full `SandstoneConfig`.
 * The agent only needs the deploy targets, not pack metadata; the
 * watcher publishes this once it has applied all CLI/env overrides.
 *
 * `undefined` when the daemon was started without a config (no
 * watcher has published, and the boot-time disk load found nothing).
 */
export interface ActiveConfig {
  mode: ActiveMode
  /** Absolute path to the loaded `sandstone.config.ts`. */
  configPath: string
  /** Resolved deploy config (post-CLI-override). */
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

/**
 * Auto-detect mode by config-file presence. `sandstone.config.ts` at
 * the project root → pack mode. Only `<root>/test/sandstone.config.ts`
 * → library mode. Neither → `null`.
 */
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

/**
 * Compute the build output dir for a given mode. Pure — no disk I/O.
 */
export function resolveOutputDir(projectRoot: string, mode: ActiveMode): string {
  return mode === 'pack'
    ? resolve(projectRoot, '.sandstone', 'output')
    : resolve(projectRoot, 'test', '.sandstone', 'output')
}

/**
 * Resolve the mode-aware config location and parse the file directly.
 *
 * Used by:
 *   - The daemon at startup as a fallback when no watcher is connected
 *     (so `getActiveConfig` returns *something* useful immediately).
 *   - The watcher on boot to seed its initial state before pushing it
 *     over WS.
 *
 * Returns `undefined` when neither config file is found or when the
 * resolved file fails to parse — callers should surface a clear
 * "not a Sandstone project" error in both cases.
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