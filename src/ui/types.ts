import type { SandstoneConfig,SandstonePack } from "sandstone"

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
}

export interface WatchUIAPI {
  setStatus: (status: WatchStatus, reason?: string) => void
  setChangedFiles: (files: TrackedChange[]) => void
  setBuildResult: (result: BuildResult) => void
  setLiveLog: (level: string | false, args: unknown[]) => void
}
