import path from 'path'
import os from 'os'
import { Database } from 'bun:sqlite'
import * as fs from '../../utils/fs.js'
import type { LauncherProvider, MinecraftInstance } from '../types.js'

function getModrinthCandidatePaths(): string[] {
  const home = os.homedir()
  const paths: string[] = []

  switch (process.platform) {
    case 'win32':
      paths.push(path.join(home, 'AppData/Roaming/ModrinthApp'))
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

async function getModrinthDataPath(): Promise<string | null> {
  for (const candidate of getModrinthCandidatePaths()) {
    if (await fs.pathExists(candidate)) {
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

/** Query app.db for profile metadata. Returns a Map keyed by profile path. */
function getProfilesFromDb(dataPath: string): Map<string, { name: string; version?: string }> {
  const profiles = new Map<string, { name: string; version?: string }>()
  const dbPath = path.join(dataPath, 'app.db')

  if (!Bun.file(dbPath).size) {
    // Either missing or empty — bail before sqlite trips over an ENOENT.
    return profiles
  }

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
    return (await getModrinthDataPath()) !== null
  },

  getDataPath(): string | null {
    return getModrinthCandidatePaths()[0] ?? null
  },

  async discoverInstances(): Promise<MinecraftInstance[]> {
    const dataPath = await getModrinthDataPath()
    if (!dataPath) return []

    const profilesDir = path.join(dataPath, 'profiles')
    if (!(await fs.pathExists(profilesDir))) return []

    // Get profile metadata from database
    const profileMetadata = getProfilesFromDb(dataPath)

    const instances: MinecraftInstance[] = []

    try {
      const entries = await fs.readDirEntries(profilesDir)

      for (const entry of entries) {
        if (!entry.isDirectory) continue
        // Skip hidden folders
        if (entry.name.startsWith('.')) continue

        // Modrinth profiles ARE the minecraft directory (no subdirectory)
        const minecraftPath = path.join(profilesDir, entry.name)

        // Verify it looks like a minecraft directory (has saves or mods folder)
        const hasSaves = await fs.pathExists(path.join(minecraftPath, 'saves'))
        const hasMods = await fs.pathExists(path.join(minecraftPath, 'mods'))
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
