import { dirname, resolve } from 'path'
import type { SandstoneConfig } from 'sandstone'

import { loadSandstoneConfig } from '../../utils/sandstoneConfig.js'
import { fileExists } from '../../utils/fs.js'

export type ActiveMode = 'pack' | 'library'

export interface ActiveConfig {
  mode: ActiveMode
  configPath: string
  saveConfig?: SandstoneConfig['saveOptions']
  outputDir: string
  logPath: string
  projectRoot: string
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

export async function loadActiveConfigFromDisk(projectRoot: string): Promise<ActiveConfig | undefined> {
  const resolved = await resolveActiveMode(projectRoot)
  if (!resolved) return undefined
  const cfg = await loadSandstoneConfig(dirname(resolved.configPath))
  if (!cfg) return undefined

  return {
    mode: resolved.mode,
    configPath: resolved.configPath,
    saveConfig: cfg.saveOptions,
    outputDir: resolveOutputDir(projectRoot, resolved.mode),
    logPath: resolve(projectRoot, '.sandstone', 'watch.log'),
    projectRoot,
    loadedAt: new Date().toISOString(),
  }
}