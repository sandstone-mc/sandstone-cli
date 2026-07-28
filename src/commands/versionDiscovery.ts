/**
 * Dynamic discovery of available Sandstone versions for the create command.
 *
 * Source priority:
 *   1. `gh api repos/sandstone-mc/sandstone/tags --paginate`
 *   2. Raw fetch to https://api.github.com/repos/sandstone-mc/sandstone/tags
 *   3. fetch(https://registry.npmjs.org/sandstone) → dist-tags field
 *   4. Hardcoded `[1.1.0, 1.0.0]` last-resort list
 *
 * Each entry includes an MC version (major.minor only) derived from the
 * shared `sandstoneMinorToMC` helper — no file lookup, no network call.
 *
 * PM-agnostic: never shells out to `npm`/`bun`/etc.
 */

import { hasGh } from '../utils.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { SemVer } from 'semver'
import { sandstoneMinorToMCString } from '../utils/sandstoneToMC.js'

const execFileAsync = promisify(execFile)

export interface DiscoveredVersion {
	major: number
	minor: number
	mcVersion: string
	source: 'gh' | 'fetch-github' | 'fetch-npm' | 'fallback'
}

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/

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
		return stdout.split('\n').map((s: string) => s.trim()).filter(Boolean)
	} catch {
		return null
	}
}

async function fetchViaGithubApi(): Promise<string[] | null> {
	try {
		const res = await fetch('https://api.github.com/repos/sandstone-mc/sandstone/tags?per_page=100')
		if (!res.ok) return null
		const data = await res.json() as Array<{ name: string }>
		return data.map((t) => t.name)
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
		// Each value is a version like "1.1.0" — return as tag-like names (with v prefix).
		return Object.values(data['dist-tags']).map((v) => `v${v}`)
	} catch {
		return null
	}
}

const FALLBACK: DiscoveredVersion[] = [
	{ major: 1, minor: 1, mcVersion: sandstoneMinorToMCString(1), source: 'fallback' },
	{ major: 1, minor: 0, mcVersion: sandstoneMinorToMCString(0), source: 'fallback' },
]

/**
 * Latest sandstone minor bundled with this CLI (read from the installed
 * `sandstone` package). Used to cap the version list: minors above this are
 * not yet released and must not be offered.
 */
function getBundledSandstoneMinor(): number | null {
	let dir = path.dirname(fileURLToPath(import.meta.url))
	for (let i = 0; i < 8; i++) {
		try {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(dir, 'node_modules', 'sandstone', 'package.json'), 'utf8')
			) as { version?: string }
			if (pkg.version) return new SemVer(pkg.version).minor
		} catch {
			// not found at this level — walk up
		}
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

function dedupeAndDecorate(
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
	const cap = getBundledSandstoneMinor()
	const filter = (list: DiscoveredVersion[]) =>
		cap === null ? list : list.filter((v) => v.minor <= cap)
	const gh = await fetchViaGh()
	if (gh) {
		const decorated = filter(dedupeAndDecorate(gh, 'gh'))
		if (decorated.length > 0) return decorated
	}
	const api = await fetchViaGithubApi()
	if (api) {
		const decorated = filter(dedupeAndDecorate(api, 'fetch-github'))
		if (decorated.length > 0) return decorated
	}
	const npm = await fetchViaNpmRegistry()
	if (npm) {
		const decorated = filter(dedupeAndDecorate(npm, 'fetch-npm'))
		if (decorated.length > 0) return decorated
	}
	console.warn('Could not list Sandstone versions — using cached list')
	return filter(FALLBACK)
}
