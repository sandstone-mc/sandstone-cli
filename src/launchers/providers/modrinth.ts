import fs from 'fs'
import path from 'path'
import os from 'os'
import { Database } from 'bun:sqlite'
import type { LauncherProvider, MinecraftInstance } from '../types.js'

function getModrinthCandidatePaths(): string[] {
  const home = os.homedir()
  const paths: string[] = []

  switch (os.platform()) {
    case 'win32':
      paths.push(path.join(os.homedir(), 'AppData/Roaming/ModrinthApp'))
      break
    case 'darwin':
      paths.push(path.join(home, 'Library/Application Support/ModrinthApp'))
      break
    case 'linux':
    default: {
      // Check XDG_DATA_HOME first
      const xdgDataHome = process.env.XDG_DATA_HOME
      if (xdgDataHome) {
        paths.push(path.join(xdgDataHome, 'ModrinthApp'))
      }
      // Standard location
      paths.push(path.join(home, '.local/share/ModrinthApp'))
      // Flatpak location
      paths.push(path.join(home, '.var/app/com.modrinth.ModrinthApp/data/ModrinthApp'))
      break
    }
  }

  return paths
}

function getModrinthDataPath(): string | null {
  for (const candidate of getModrinthCandidatePaths()) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

interface ProfileRow {
  path: string
  name: string
  game_version: string | null
}

/** Query app.db for profile metadata */
function getProfilesFromDb(dataPath: string): Map<string, { name: string; version?: string }> {
  const profiles = new Map<string, { name: string; version?: string }>()
  const dbPath = path.join(dataPath, 'app.db')

  if (!fs.existsSync(dbPath)) return profiles

  try {
    const db = new Database(dbPath, { readonly: true })
    const rows = db.query<ProfileRow, []>('SELECT path, name, game_version FROM profiles').all()

    for (const row of rows) {
      profiles.set(row.path, {
        name: row.name,
        version: row.game_version ?? undefined,
      })
    }

    db.close()
  } catch {
    // Database read failed
  }

  return profiles
}

export const modrinthProvider: LauncherProvider = {
  type: 'modrinth',
  displayName: 'Modrinth App',

  async isInstalled(): Promise<boolean> {
    return getModrinthDataPath() !== null
  },

  getDataPath(): string | null {
    return getModrinthDataPath()
  },

  async discoverInstances(): Promise<MinecraftInstance[]> {
    const dataPath = getModrinthDataPath()
    if (!dataPath) return []

    const profilesDir = path.join(dataPath, 'profiles')
    if (!fs.existsSync(profilesDir)) return []

    // Get profile metadata from database
    const profileMetadata = getProfilesFromDb(dataPath)

    const instances: MinecraftInstance[] = []

    try {
      const entries = fs.readdirSync(profilesDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        // Skip hidden folders
        if (entry.name.startsWith('.')) continue

        // Modrinth profiles ARE the minecraft directory (no subdirectory)
        const minecraftPath = path.join(profilesDir, entry.name)

        // Verify it looks like a minecraft directory (has saves or mods folder)
        const hasSaves = fs.existsSync(path.join(minecraftPath, 'saves'))
        const hasMods = fs.existsSync(path.join(minecraftPath, 'mods'))
        if (!hasSaves && !hasMods) continue

        // Get metadata from database
        const metadata = profileMetadata.get(entry.name)

        instances.push({
          id: `modrinth-${entry.name}`,
          name: metadata?.name || entry.name,
          launcher: 'modrinth',
          minecraftPath,
          version: metadata?.version,
        })
      }
    } catch {
      // Directory read failed
    }

    return instances
  },
}
