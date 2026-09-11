/**
 * Sandstone → Minecraft version derivation.
 *
 * Per the workspace CLAUDE.md:
 *   Sandstone `1.{minor}.*` ↔ MC `(26 + floor(minor/4)).((minor % 4) + 1)`
 *
 * The MC version string for any given sandstone release is looked up
 * against PrismLauncher's `net.minecraft/index.json`, which lists every
 * MC release + snapshot + pre-release. We filter by the computed
 * `mcBaseVersion` (e.g. `26.3`), sort by `releaseTime` descending, and
 * pick the first match — preferring `type === "release"` for stable
 * sandstone releases, accepting `type === "snapshot"` when the user
 * opts into a snapshot/pre-release build of sandstone.
 */

import { ghFetchText } from '../utils/github.js'

export type MinecraftVersionType = 'release' | 'snapshot' | 'old_alpha' | 'old_beta'

export interface MinecraftVersion {
  /** The full MC version string (e.g. "26.3" or "26.3-snapshot-10"). */
  version: string
  type: MinecraftVersionType
  releaseTime: string
}

export interface IndexEntry extends MinecraftVersion {
  sha256: string
  requires: Array<{ uid: string; suggests: string }>
  recommended: boolean
}

const INDEX_URL =
  'https://raw.githubusercontent.com/PrismLauncher/meta-launcher/master/net.minecraft/index.json'

let cachedIndex: IndexEntry[] | null = null

async function loadIndex(): Promise<IndexEntry[]> {
  if (cachedIndex) return cachedIndex
  // raw.githubusercontent.com — use the github util so `gh auth` and
  // rate-limit handling kick in automatically.
  const json = (await ghFetchText(INDEX_URL, { headers: { Accept: 'application/json' } })
    .then((text) => JSON.parse(text))) as { versions: IndexEntry[] }
  cachedIndex = json.versions
  return cachedIndex
}

/**
 * Sandstone `1.{minor}.*` → MC base version `(26 + floor(minor/4)).((minor % 4) + 1)`.
 * E.g. minor=2 → "26.3"; minor=5 → "27.2".
 *
 * Note: this assumes the existing sandstone 1.x major. Major 2 will need
 * its own mapping when it ships.
 */
export function sandstoneToMcBase(sandstoneVersion: string): string {
  const m = sandstoneVersion.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) {
    throw new Error(
      `Can't parse sandstone version "${sandstoneVersion}" — expected "X.Y.Z"`,
    )
  }
  const major = Number(m[1])
  const minor = Number(m[2])
  if (major !== 1) {
    throw new Error(
      `Don't know how to map sandstone major ${major} → MC base — only major 1 is supported`,
    )
  }
  const mcMajor = 26 + Math.floor(minor / 4)
  const mcMinor = (minor % 4) + 1
  return `${mcMajor}.${mcMinor}`
}

/**
 * Find the latest MC version whose `version` starts with `mcBaseVersion`.
 * If `preferSnapshot` is true, looks for `type === "snapshot"` entries
 * (e.g. "26.3-snapshot-10"); otherwise looks for the matching release
 * (e.g. "26.3").
 *
 * Throws if no match exists — caller's responsibility to surface a
 * useful error if the user's sandstone version points at an MC release
 * that hasn't shipped yet.
 */
export async function findLatestMcVersion(
  mcBaseVersion: string,
  preferSnapshot: boolean,
): Promise<MinecraftVersion> {
  const entries = await loadIndex()
  const prefix = mcBaseVersion
  const wantedType: MinecraftVersionType = preferSnapshot ? 'snapshot' : 'release'

  // Among all entries whose `version` starts with the base AND whose
  // `type` matches, take the one with the most recent `releaseTime`.
  let best: IndexEntry | null = null
  for (const entry of entries) {
    if (typeof entry.version !== 'string') continue
    if (!entry.version.startsWith(prefix)) continue
    if (entry.type !== wantedType) continue
    if (!best || entry.releaseTime > best.releaseTime) best = entry
  }
  if (!best) {
    const tried = preferSnapshot
      ? `snapshot or release for ${mcBaseVersion}`
      : `release for ${mcBaseVersion}`
    throw new Error(
      `No MC ${tried} found in PrismLauncher meta-launcher index — does Minecraft ${mcBaseVersion} exist yet?`,
    )
  }
  return {
    version: best.version,
    type: best.type,
    releaseTime: best.releaseTime,
  }
}

/**
 * One-shot helper: parse a sandstone version, derive the MC base, and
 * return the latest matching MC version (release or snapshot per
 * `preferSnapshot`).
 */
export async function sandstoneToMcVersion(
  sandstoneVersion: string,
  preferSnapshot: boolean,
): Promise<MinecraftVersion> {
  const mcBase = sandstoneToMcBase(sandstoneVersion)
  return await findLatestMcVersion(mcBase, preferSnapshot)
}

/** Test-only: clear the in-memory index cache. */
export function __resetSandstoneVersionCache(): void {
  cachedIndex = null
}