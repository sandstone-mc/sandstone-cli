import fs from 'fs'
import path from 'path'
import os from 'os'
import type { LauncherProvider, MinecraftInstance } from '../types.js'

function getVanillaPath(): string | null {
  const home = os.homedir()
  let mcPath: string

  switch (os.platform()) {
    case 'win32':
      mcPath = path.join(home, 'AppData/Roaming/.minecraft')
      break
    case 'darwin':
      mcPath = path.join(home, 'Library/Application Support/minecraft')
      break
    case 'linux':
    default:
      mcPath = path.join(home, '.minecraft')
      break
  }

  return fs.existsSync(mcPath) ? mcPath : null
}

export const vanillaProvider: LauncherProvider = {
  type: 'vanilla',
  displayName: 'Vanilla Minecraft',

  async isInstalled(): Promise<boolean> {
    return getVanillaPath() !== null
  },

  getDataPath(): string | null {
    return getVanillaPath()
  },

  async discoverInstances(): Promise<MinecraftInstance[]> {
    const dataPath = getVanillaPath()
    if (!dataPath) return []

    return [{
      id: 'vanilla',
      name: 'Vanilla Minecraft',
      launcher: 'vanilla',
      minecraftPath: dataPath,
    }]
  },
}
