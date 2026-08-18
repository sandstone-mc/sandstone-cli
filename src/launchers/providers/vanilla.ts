import path from 'path'
import os from 'os'
import * as fs from '../../utils/fs.js'
import type { LauncherProvider, MinecraftInstance } from '../types.js'

async function getVanillaPath(): Promise<string | null> {
  const home = os.homedir()
  let mcPath: string

  switch (process.platform) {
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

  return (await fs.pathExists(mcPath)) ? mcPath : null
}

export const vanillaProvider: LauncherProvider = {
  type: 'vanilla',
  displayName: 'Vanilla Minecraft',

  async isInstalled(): Promise<boolean> {
    return (await getVanillaPath()) !== null
  },

  getDataPath(): string | null {
    // Kept synchronous per the provider interface contract; mirrors the
    // behavior when the .minecraft folder is on the standard path. Falls
    // back to the synchronous guess only if you don't want to await —
    // async discoverInstances() is the authoritative answer.
    const home = os.homedir()
    let mcPath: string
    switch (process.platform) {
      case 'win32': mcPath = path.join(home, 'AppData/Roaming/.minecraft'); break
      case 'darwin': mcPath = path.join(home, 'Library/Application Support/minecraft'); break
      default: mcPath = path.join(home, '.minecraft')
    }
    return mcPath
  },

  async discoverInstances(): Promise<MinecraftInstance[]> {
    const dataPath = await getVanillaPath()
    if (!dataPath) return []

    return [{
      id: 'vanilla',
      name: 'Vanilla Minecraft',
      launcher: 'vanilla',
      minecraftPath: dataPath,
    }]
  },
}
