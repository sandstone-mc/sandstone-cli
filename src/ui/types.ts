import type { SandstoneConfig,SandstonePack } from "sandstone"
import type { ActiveSaveConfig } from '../utils/activeSaveConfig.js'

export type WatchStatus = 'watching' | 'building' | 'restarting' | 'error' | 'pending'

export type ChangeCategory = 'src' | 'resources' | 'config' | 'dependencies' | 'other'

export interface TrackedChange {
  path: string
  category: ChangeCategory
}

export interface ResourceCounts {
  functions: number
  other: number
}

export interface BuildResult {
  success: boolean
  error?: string
  resourceCounts: ResourceCounts
  timestamp: number
  sandstoneConfig?: SandstoneConfig
  sandstonePack?: SandstonePack
  resetSandstonePack?: () => void
  /**
   * The deploy targets the build pipeline actually wrote to (after any
   * script-side mutations of `local.worldName`/`local.clientPath`/etc).
   * `undefined` on failure or when the build never ran. The watcher
   * captures this on every successful build and re-publishes it to
   * the `sand connect` daemon so MCP sees the latest values, not
   * just the static CLI-merge.
   */
  activeSaveConfig?: ActiveSaveConfig
}

export interface WatchUIAPI {
  setStatus: (status: WatchStatus, reason?: string) => void
  setChangedFiles: (files: TrackedChange[]) => void
  setBuildResult: (result: BuildResult) => void
  setLiveLog: (level: string | false, args: unknown[]) => void
  exit: (() => void) | undefined
}
