import fs from 'fs'
import path from 'path'
import os from 'os'
import type { LauncherProvider, MinecraftInstance } from '../types.js'

function getPrismCandidatePaths(): string[] {
  const home = os.homedir()
  const paths: string[] = []

  switch (os.platform()) {
    case 'win32':
      paths.push(path.join(os.homedir(), 'AppData/Roaming/PrismLauncher'))
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

function getPrismDataPath(): string | null {
  for (const candidate of getPrismCandidatePaths()) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/** Parse INI-style instance.cfg to extract instance name */
function parseInstanceConfig(configPath: string): { name?: string } {
  try {
    const content = fs.readFileSync(configPath, 'utf-8')
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
function parsePackJson(packPath: string): { version?: string } {
  try {
    const content = fs.readFileSync(packPath, 'utf-8')
    const pack = JSON.parse(content)

    // Look for net.minecraft component
    const components = pack.components as Array<{ uid: string; version: string }> | undefined
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
    return getPrismDataPath() !== null
  },

  getDataPath(): string | null {
    return getPrismDataPath()
  },

  async discoverInstances(): Promise<MinecraftInstance[]> {
    const dataPath = getPrismDataPath()
    if (!dataPath) return []

    const instancesDir = path.join(dataPath, 'instances')
    if (!fs.existsSync(instancesDir)) return []

    const instances: MinecraftInstance[] = []

    try {
      const entries = fs.readdirSync(instancesDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        // Skip hidden folders and special folders
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue

        const instanceDir = path.join(instancesDir, entry.name)
        const minecraftDir = path.join(instanceDir, 'minecraft')
        const dotMinecraftDir = path.join(instanceDir, '.minecraft')

        // Prism uses 'minecraft' or '.minecraft' subdirectory
        let minecraftPath: string | null = null
        if (fs.existsSync(minecraftDir)) {
          minecraftPath = minecraftDir
        } else if (fs.existsSync(dotMinecraftDir)) {
          minecraftPath = dotMinecraftDir
        }

        if (!minecraftPath) continue

        // Parse instance.cfg for display name
        const configPath = path.join(instanceDir, 'instance.cfg')
        const config = parseInstanceConfig(configPath)

        // Parse mmc-pack.json for Minecraft version
        const packPath = path.join(instanceDir, 'mmc-pack.json')
        const pack = parsePackJson(packPath)

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
