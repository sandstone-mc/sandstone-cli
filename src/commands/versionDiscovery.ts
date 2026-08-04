/**
 * Dynamic discovery of available Sandstone versions for the create command.
 *
 * Source priority:
 *   1. `gh api repos/sandstone-mc/sandstone/tags --paginate`
 *   2. Raw fetch to https://api.github.com/repos/sandstone-mc/sandstone/tags
 *   3. fetch(https://registry.npmjs.org/sandstone) → dist-tags field
 *   4. Hardcoded `[1.2.0, 1.1.0, 1.0.0]` last-resort list
 *
 * Each entry includes an MC version (major.minor only) derived from the
 * shared `sandstoneMinorToMC` helper — no file lookup, no network call.
 *
 * PM-agnostic: never shells out to `npm`/`bun`/etc.
 */

import { hasGh } from '../utils/index.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { sandstoneMinorToMCString } from '../utils/sandstoneToMC.js'

const execFileAsync = promisify(execFile)

export interface DiscoveredVersion {
  major: number
  minor: number
  mcVersion: string
  source: 'gh' | 'fetch-github' | 'fetch-npm' | 'fallback'
}

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/

/**
 * Drop tags that don't follow the format established since 1.0.0:
 *   - regex shape `v{X}.{Y}.{Z}` (already enforced by TAG_RE)
 *   - major must be >= 1 — pre-1.0 `0.x.y` tags are historical, not maintained
 *   - no prereleases (beta/alpha/rc) — already enforced by TAG_RE
 */
function filterMaintainedTags(tags: string[]): string[] {
  return tags.filter((t) => {
    const m = t.match(TAG_RE)
    if (!m) return false
    return parseInt(m[1]!, 10) >= 1
  })
}

async function fetchViaGh(): Promise<string[] | null> {
  if (!hasGh()) return null
  try {
    const { stdout } = await execFileAsync('gh', [
      'api',
      'repos/sandstone-mc/sandstone/tags',
      '--paginate',
      '--jq',
      '.[].name',
    ])
    return filterMaintainedTags(stdout.split('\n').map((s: string) => s.trim()).filter(Boolean))
  } catch {
    return null
  }
}

async function fetchViaGithubApi(): Promise<string[] | null> {
  try {
    const res = await fetch('https://api.github.com/repos/sandstone-mc/sandstone/tags?per_page=100')
    if (!res.ok) return null
    const data = await res.json() as Array<{ name: string }>
    return filterMaintainedTags(data.map((t) => t.name))
  } catch {
    return null
  }
}

async function fetchViaNpmRegistry(): Promise<string[] | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/sandstone')
    if (!res.ok) return null
    const data = await res.json() as { 'dist-tags'?: Record<string, string> }
    if (!data['dist-tags']) return null
    // Only keep maintained-channel dist-tags: `latest` plus `sandstone-{major}-{minor}`.
    // Drop everything else (`next`, `beta`, legacy tags, etc.).
    const versions = Object.entries(data['dist-tags'])
      .filter(([key]) => key === 'latest' || /^sandstone-\d+-\d+$/.test(key))
      .map(([, v]) => `v${v}`)
    return filterMaintainedTags(versions)
  } catch {
    return null
  }
}

const FALLBACK: DiscoveredVersion[] = [
  { major: 1, minor: 2, mcVersion: sandstoneMinorToMCString(2), source: 'fallback' },
  { major: 1, minor: 1, mcVersion: sandstoneMinorToMCString(1), source: 'fallback' },
  { major: 1, minor: 0, mcVersion: sandstoneMinorToMCString(0), source: 'fallback' },
]

export function dedupeAndDecorate(
  tags: string[],
  source: DiscoveredVersion['source']
): DiscoveredVersion[] {
  const seen = new Set<string>()
  const out: DiscoveredVersion[] = []
  for (const t of tags) {
    const m = t.match(TAG_RE)
    if (!m) continue
    const [, maj, min] = m
    const key = `${maj}.${min}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      major: parseInt(maj!, 10),
      minor: parseInt(min!, 10),
      mcVersion: sandstoneMinorToMCString(parseInt(min!, 10)),
      source,
    })
  }
  // Sort descending by minor (highest first)
  out.sort((a, b) => b.minor - a.minor || b.major - a.major)
  return out
}

export async function getAvailableSandstoneVersions(): Promise<DiscoveredVersion[]> {
  const gh = await fetchViaGh()
  if (gh) {
    const decorated = dedupeAndDecorate(gh, 'gh')
    if (decorated.length > 0) return decorated
  }
  const api = await fetchViaGithubApi()
  if (api) {
    const decorated = dedupeAndDecorate(api, 'fetch-github')
    if (decorated.length > 0) return decorated
  }
  const npm = await fetchViaNpmRegistry()
  if (npm) {
    const decorated = dedupeAndDecorate(npm, 'fetch-npm')
    if (decorated.length > 0) return decorated
  }
  console.warn('Could not list Sandstone versions — using cached list')
  return FALLBACK
}
