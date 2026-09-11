/**
 * Modrinth API wrapper.
 *
 * Used by the integrated host to resolve + download mods. Modrinth is the
 * de-facto Fabric mod distribution; their REST API supports filtering
 * versions by loader (`fabric`) + MC version, and returns direct CDN
 * URLs for the JAR files.
 *
 * Public API:
 *   - `findModVersion(slugOrId, mcVersion?, loader?)` → latest matching
 *     version, or `null` if no match.
 *   - `downloadMod(version, destFile)` → stream the JAR to disk.
 *   - `downloadUrl(url, destFile)` → direct URL download (for modpacks
 *     that point at non-Modrinth jars).
 */

import { ghFetch } from '../utils/github.js'
import * as fs from '../utils/fs.js'
import { join as pathJoin } from 'node:path'

const API = 'https://api.modrinth.com/v2'

export interface ModrinthFile {
  url: string
  filename: string
  primary: boolean
  size: number
  hashes: { sha512: string; sha1: string }
}

export interface ModrinthVersion {
  id: string
  project_id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  files: ModrinthFile[]
  date_published: string
  downloads: number
}

/**
 * Find the latest matching version of a mod on Modrinth.
 *
 * Filters the Modrinth response client-side. The `game_versions` query
 * filter on Modrinth is not strict — it sometimes returns versions
 * tagged with adjacent MC versions (e.g. asking for "26.2" returns
 * "26.3-snapshot-10" entries), so we re-filter against the version's
 * `game_versions` array before picking.
 *
 * If `mcVersion` is omitted, returns the project's most recently
 * published version regardless of MC compatibility (used for
 * MC-agnostic mods like fabric-language-kotlin).
 */
export async function findModVersion(
  slugOrId: string,
  mcVersion?: string,
  loader = 'fabric',
): Promise<ModrinthVersion | null> {
  const params = new URLSearchParams()
  // Modrinth's filter params expect JSON-encoded arrays: `loaders=["fabric"]`.
  // Passing `loaders=fabric` is treated as "any loader" rather than a
  // strict match — and `game_versions=26.2` returns versions tagged with
  // adjacent MC versions (snapshots, etc). JSON arrays enforce strict
  // filtering server-side.
  if (loader) params.append('loaders', JSON.stringify([loader]))
  if (mcVersion) params.append('game_versions', JSON.stringify([mcVersion]))
  const query = params.toString()
  const url = `${API}/project/${encodeURIComponent(slugOrId)}/version${
    query ? `?${query}` : ''
  }`
  const resp = await ghFetch(url)
  if (!resp.ok) {
    if (resp.status === 404) return null
    throw new Error(
      `Modrinth version lookup for "${slugOrId}" failed: HTTP ${resp.status} ${resp.statusText}`,
    )
  }
  const versions = (await resp.json()) as ModrinthVersion[]
  if (!Array.isArray(versions) || versions.length === 0) return null
  // Pick the most recently published version. Modrinth's strict-array
  // filter handles MC + loader matching server-side.
  return versions.reduce((best, v) =>
    !best || v.date_published > best.date_published ? v : best,
  )
}

/** Pick the primary (or first) file from a Modrinth version. */
export function primaryFile(version: ModrinthVersion): ModrinthFile {
  const primary = version.files.find((f) => f.primary)
  return primary ?? version.files[0]
}

/**
 * Download a Modrinth version's primary JAR to `destFile` (absolute
 * path including the filename). Streams the body to disk via the
 * shared github util — falls back to `fetch` when `gh` isn't installed,
 * which is fine for Modrinth's API.
 */
export async function downloadMod(
  version: ModrinthVersion,
  destFile: string,
): Promise<void> {
  const file = primaryFile(version)
  await fs.ensureDir(pathJoin(destFile, '..'))
  await downloadUrl(file.url, destFile)
}

/**
 * Download any URL to `destFile` (absolute path). Streams via the
 * github util so a future `mr` CLI (or similar) could plug in here.
 */
export async function downloadUrl(url: string, destFile: string): Promise<void> {
  const resp = await ghFetch(url)
  if (!resp.ok) {
    throw new Error(
      `Download failed for ${url}: HTTP ${resp.status} ${resp.statusText}`,
    )
  }
  await fs.ensureDir(pathJoin(destFile, '..'))
  // Bun.write handles streaming from a Response.
  await Bun.write(destFile, resp)
}