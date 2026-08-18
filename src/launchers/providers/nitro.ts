import path from 'path'
import os from 'os'
import * as fs from '../../utils/fs.js'
import type { LauncherProvider, MinecraftInstance } from '../types.js'

function getNitroCandidatePaths(): string[] {
  const home = os.homedir()
  const paths: string[] = []

  switch (process.platform) {
    case 'win32':
      paths.push(path.join(home, 'AppData/Roaming/nitro/nitro/data'))
      break
    case 'darwin':
      paths.push(path.join(home, 'Library/Application Support/.nitro.nitro'))
      break
    case 'linux':
    default: {
      // XDG_DATA_HOME first
      const xdgDataHome = process.env.XDG_DATA_HOME
      if (xdgDataHome) {
        paths.push(path.join(xdgDataHome, 'nitro'))
      }
      // Standard location
      paths.push(path.join(home, '.local/share/nitro'))
      // Flatpak location
      paths.push(path.join(home, '.var/app/io.github.nitrolaunch.Nitrolaunch/data/nitro'))
      break
    }
  }

  return paths
}

async function getNitroDataPath(): Promise<string | null> {
  for (const candidate of getNitroCandidatePaths()) {
    if (await fs.pathExists(candidate)) {
      return candidate
    }
  }
  return null
}

/** Parse nitro_lock.json for Minecraft version */
async function parseNitroLock(lockPath: string): Promise<{ version?: string }> {
  try {
    const lock = JSON.parse(await fs.readText(lockPath)) as { minecraft_version?: string }

    if (typeof lock.minecraft_version === 'string') {
      return { version: lock.minecraft_version }
    }

    return {}
  } catch {
    return {}
  }
}

export const nitroProvider: LauncherProvider = {
  type: 'nitro',
  displayName: 'Nitrolaunch',

  async isInstalled(): Promise<boolean> {
    return (await getNitroDataPath()) !== null
  },

  getDataPath(): string | null {
    return getNitroCandidatePaths()[0] ?? null
  },

  async discoverInstances(): Promise<MinecraftInstance[]> {
    const dataPath = await getNitroDataPath()
    if (!dataPath) return []

    const instancesDir = path.join(dataPath, 'instances')
    if (!(await fs.pathExists(instancesDir))) return []

    const instances: MinecraftInstance[] = []

    try {
      const entries = await fs.readDirEntries(instancesDir)

      for (const entry of entries) {
        if (!entry.isDirectory) continue
        // Skip hidden folders
        if (entry.name.startsWith('.')) continue

        const instanceDir = path.join(instancesDir, entry.name)
        const minecraftDir = path.join(instanceDir, '.minecraft')

        if (!(await fs.pathExists(minecraftDir))) continue

        // Parse nitro_lock.json for Minecraft version
        const lockPath = path.join(minecraftDir, 'nitro_lock.json')
        const lock = await parseNitroLock(lockPath)

        instances.push({
          id: `nitro-${entry.name}`,
          name: entry.name,
          launcher: 'nitro',
          minecraftPath: minecraftDir,
          version: lock.version,
        })
      }
    } catch {
      // Directory read failed
    }

    return instances
  },
}
