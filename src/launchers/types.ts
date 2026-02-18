export type LauncherType = 'vanilla' | 'prism' | 'modrinth'

export interface MinecraftInstance {
  /** Unique identifier, e.g., "prism-Homestead" */
  id: string
  /** Display name from config or folder name */
  name: string
  /** Which launcher this instance belongs to */
  launcher: LauncherType
  /** Path to minecraft directory (where saves/ lives) */
  minecraftPath: string
  /** Optional game version for display */
  version?: string
}

export interface LauncherProvider {
  /** Unique identifier for this launcher */
  readonly type: LauncherType
  /** Human-readable name for display */
  readonly displayName: string
  /** Check if this launcher is installed on the system */
  isInstalled(): Promise<boolean>
  /** Get the data path for this launcher (first valid path found) */
  getDataPath(): string | null
  /** Discover all instances for this launcher */
  discoverInstances(): Promise<MinecraftInstance[]>
}

export interface DiscoveryResult {
  instances: MinecraftInstance[]
  errors: Map<LauncherType, Error>
}
