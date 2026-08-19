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
    if (await fs.pathExists(path.join(candidate, 'profiles'))) {
      return candidate
    }
  }
  return null
}

interface ProfileRow {
  path: string
  name: string
  applied_content_set_id: string | null
}

/** Query app.db for profile metadata. Returns a Map keyed by profile path. */
function getProfilesFromDb(dataPath: string): Map<string, { name: string; version?: string }> {
  const profiles = new Map<string, { name: string; version?: string }>()
  const dbPath = path.join(dataPath, 'app.db')

  let size = 0
  try {
    size = Bun.file(dbPath).size
  } catch {
    // Either missing or empty — bail before sqlite trips over an ENOENT.
    return profiles
  }
  if (!size) return profiles

  try {
    const db = new Database(dbPath, { readonly: true, create: false })

    const rows = db.query<ProfileRow, []>('SELECT path, name, applied_content_set_id FROM instances').all()

    if (rows.length === 0) {
      db.close()
      return profiles
    }

    const setIds = new Set<string>()
    for (const row of rows) if (row.applied_content_set_id) setIds.add(row.applied_content_set_id)
    const placeholders = Array.from(setIds).map(() => '?').join(',')
    const versionsBySet = new Map<string, string>()
    if (setIds.size > 0) {
      const versionRows = db.query<{ id: string; game_version: string | null }, string[]>(
        `SELECT id, game_version FROM instance_content_sets WHERE id IN (${placeholders})`,
      ).all(...setIds)
      for (const v of versionRows) {
        if (v.game_version) versionsBySet.set(v.id, v.game_version)
      }
    }

    for (const row of rows) {
      profiles.set(path.basename(row.path), {
        name: row.name,
        version: row.applied_content_set_id ? versionsBySet.get(row.applied_content_set_id) : undefined,
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
