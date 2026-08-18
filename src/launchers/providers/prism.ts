import path from 'path'
import os from 'os'
import * as fs from '../../utils/fs.js'
import type { LauncherProvider, MinecraftInstance } from '../types.js'

function getPrismCandidatePaths(): string[] {
  const home = os.homedir()
  const paths: string[] = []

  switch (process.platform) {
    case 'win32':
      paths.push(path.join(home, 'AppData/Roaming/PrismLauncher'))
      break
    case 'darwin':
      paths.push(path.join(home, 'Library/Application Support/PrismLauncher'))
      break
    case 'linux':
    default: {
      // Check XDG_DATA_HOME first
      const xdgDataHome = process.env.XDG_DATA_HOME
      if (xdgDataHome) {
        paths.push(path.join(xdgDataHome, 'PrismLauncher'))
      }
      // Standard location
      paths.push(path.join(home, '.local/share/PrismLauncher'))
      // Flatpak location
      paths.push(path.join(home, '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher'))
      break
    }
  }

  return paths
}

async function getPrismDataPath(): Promise<string | null> {
  for (const candidate of getPrismCandidatePaths()) {
    if (await fs.pathExists(candidate)) {
      return candidate
    }
  }
  return null
}

/** Parse INI-style instance.cfg to extract instance name */
async function parseInstanceConfig(configPath: string): Promise<{ name?: string }> {
  try {
    const content = await fs.readText(configPath)
    const result: { name?: string } = {}

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('name=')) {
        result.name = trimmed.slice(5)
        break
      }
    }

    return result
  } catch {
    return {}
  }
}

/** Parse mmc-pack.json to extract Minecraft version */
async function parsePackJson(packPath: string): Promise<{ version?: string }> {
  try {
    const pack = JSON.parse(await fs.readText(packPath)) as { components?: Array<{ uid: string; version: string }> }

    // Look for net.minecraft component
    const components = pack.components
    if (components) {
      const minecraft = components.find(c => c.uid === 'net.minecraft')
      if (minecraft?.version) {
        return { version: minecraft.version }
      }
    }

    return {}
  } catch {
    return {}
  }
}

export const prismProvider: LauncherProvider = {
  type: 'prism',
  displayName: 'Prism Launcher',

  async isInstalled(): Promise<boolean> {
    return (await getPrismDataPath()) !== null
  },

  getDataPath(): string | null {
    // Best-effort synchronous guess; the async `isInstalled`/`discoverInstances`
    // paths are the authoritative checks. Returning the first existing
    // candidate without an await is a hot-path optimization for the
    // registry's "is this provider usable?" probe.
    return getPrismCandidatePaths()[0] ?? null
  },

  async discoverInstances(): Promise<MinecraftInstance[]> {
    const dataPath = await getPrismDataPath()
    if (!dataPath) return []

    const instancesDir = path.join(dataPath, 'instances')
    if (!(await fs.pathExists(instancesDir))) return []

    const instances: MinecraftInstance[] = []

    try {
      const entries = await fs.readDirEntries(instancesDir)

      for (const entry of entries) {
        if (!entry.isDirectory) continue
        // Skip hidden folders and special folders
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue

        const instanceDir = path.join(instancesDir, entry.name)
        const minecraftDir = path.join(instanceDir, 'minecraft')
        const dotMinecraftDir = path.join(instanceDir, '.minecraft')

        // Prism uses 'minecraft' or '.minecraft' subdirectory
        let minecraftPath: string | null = null
        if (await fs.pathExists(minecraftDir)) {
          minecraftPath = minecraftDir
        } else if (await fs.pathExists(dotMinecraftDir)) {
          minecraftPath = dotMinecraftDir
        }

        if (!minecraftPath) continue

        // Parse instance.cfg for display name
        const configPath = path.join(instanceDir, 'instance.cfg')
        const config = await parseInstanceConfig(configPath)

        // Parse mmc-pack.json for Minecraft version
        const packPath = path.join(instanceDir, 'mmc-pack.json')
        const pack = await parsePackJson(packPath)

        instances.push({
          id: `prism-${entry.name}`,
          name: config.name || entry.name,
          launcher: 'prism',
          minecraftPath,
          version: pack.version,
        })
      }
    } catch {
      // Directory read failed
    }

    return instances
  },
}
