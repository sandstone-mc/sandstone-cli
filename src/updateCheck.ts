/**
 * Update checks for sandstone + the CLI itself.
 *
 * Runs on every `sand build` and `sand watch` invocation. Designed to be:
 *   - Non-blocking: completes in parallel with the build, results await
 *     until the build resolves (never delays the actual work).
 *   - PM-agnostic: never shells out to npm/bun/pnpm. Uses fetch() and
 *     detection via PATH / lockfiles for update commands.
 *   - Silent on no-update: returns `null` when up to date.
 *   - Cached: 30-minute in-memory cache so spam-running build doesn't
 *     hammer registry endpoints.
 *
 * All filesystem and shell calls use async APIs (fs/promises, promisified
 * child_process) so we never block the event loop.
 */

import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const execFileAsync = promisify(execFile)

// ---------- Types ----------

export interface SandstoneUpdateInfo {
	installed: string
	channel: 'latest' | string // 'latest' or '<pkg>-X-Y' (e.g. 'sandstone-1-0')
	available: string
	command: string // PM-adjusted command for the user's project
	mcInstalled: string
}

export interface CLIUpdateInfo {
	installed: string
	available: string
	command: string // PM-adjusted global install command
	source: 'global' | 'workspace'
}

export type UpdateCheckResult =
	| { kind: 'sandstone'; info: SandstoneUpdateInfo }
	| { kind: 'cli'; info: CLIUpdateInfo }
	| { kind: 'none' }

// ---------- Cache ----------

interface CacheEntry<T> {
	value: T
	timestamp: number
}
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const cache = new Map<string, CacheEntry<unknown>>()

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const entry = cache.get(key) as CacheEntry<T> | undefined
	if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
		return entry.value
	}
	const value = await fn()
	cache.set(key, { value, timestamp: Date.now() })
	return value
}

// ---------- npm registry fetch ----------

interface NpmPackageData {
	'dist-tags': Record<string, string>
}

async function fetchNpmPackage(packageName: string): Promise<NpmPackageData | null> {
	return cached(`npm:${packageName}`, async () => {
		try {
			const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`)
			if (!res.ok) return null
			return (await res.json()) as NpmPackageData
		} catch {
			return null
		}
	})
}

// ---------- sandstone installed version ----------

async function readInstalledSandstoneVersion(projectDir: string): Promise<string | null> {
	const pkgPath = path.join(projectDir, 'node_modules', 'sandstone', 'package.json')
	try {
		const raw = await fs.readFile(pkgPath, 'utf8')
		const pkg = JSON.parse(raw) as { version?: string }
		return pkg.version ?? null
	} catch {
		return null
	}
}

// ---------- PM detection (project level) ----------

type LocalPM = 'bun' | 'pnpm' | 'yarn' | 'npm'

export async function detectLocalPM(projectDir: string): Promise<LocalPM> {
	if (await fileExists(path.join(projectDir, 'bun.lock')) || await fileExists(path.join(projectDir, 'bun.lockb'))) return 'bun'
	if (await fileExists(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm'
	if (await fileExists(path.join(projectDir, 'yarn.lock'))) return 'yarn'
	if (await fileExists(path.join(projectDir, 'package-lock.json'))) return 'npm'
	return 'npm'
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

function localAddCommand(pm: LocalPM, spec: string): string {
	switch (pm) {
		case 'bun':
		case 'pnpm':
			return `${pm} add ${spec}`
		case 'yarn':
			return `yarn add ${spec}`
		case 'npm':
			return `npm install ${spec}`
	}
}

// ---------- PM detection (global level, via `which sand`/`where sand`) ----------

type GlobalPM = 'bun' | 'pnpm' | 'yarn' | 'npm' | 'unknown'

function isWindows(): boolean {
	return process.platform === 'win32'
}

async function findSandBinaryPath(): Promise<string | null> {
	const cmd = isWindows() ? 'where' : 'which'
	try {
		const { stdout } = await execFileAsync(cmd, ['sand'])
		const out = stdout.trim()
		if (!out) return null
		return out.split('\n')[0]!.trim()
	} catch {
		return null
	}
}

function classifyGlobalSandPath(p: string): GlobalPM {
	const lower = p.toLowerCase()
	if (lower.includes('.bun/') || lower.includes('/bun/') || lower.endsWith('\\bun\\')) return 'bun'
	if (lower.includes('pnpm') || lower.includes('/.local/share/pnpm')) return 'pnpm'
	if (lower.includes('yarn') || lower.includes('yarn/')) return 'yarn'
	if (lower.includes('node_modules') || lower.includes('\\node_modules\\') || lower.endsWith('npm')) return 'npm'
	return 'unknown'
}

function globalAddCommand(pm: GlobalPM, spec: string): string {
	switch (pm) {
		case 'bun':
			return `bun add -g ${spec}`
		case 'pnpm':
			return `pnpm add -g ${spec}`
		case 'yarn':
			return `yarn global add ${spec}`
		case 'npm':
			return `npm install -g ${spec}`
		case 'unknown':
			return `npm install -g ${spec}`
	}
}

// ---------- channel resolution ----------

/**
 * Resolve which npm dist-tag to consult for an installed package version.
 *
 * npm rejects any dist-tag that looks like a SemVer range, so the
 * per-minor channel is `<pkg-name>-<major>-<minor>` (e.g. `sandstone-1-0`),
 * not `v1.0`. We prefer the explicit per-minor tag when present (so a
 * `v1.0.x` install only sees `sandstone-1-0`-tagged releases) and fall
 * back to `latest` when the installed version is in master's minor.
 */
function resolveChannel(distTags: Record<string, string>, installed: string, packageName: string): 'latest' | string | null {
	const m = installed.match(/^(\d+)\.(\d+)\./)
	if (!m) return null
	const [, maj, min] = m
	// strip the npm scope so `@sandstone-mc/<pkg>` becomes `<pkg>` for the tag key
	const unscoped = packageName.replace(/^@[^/]+\//, '')
	const explicitKey = `${unscoped}-${maj}-${min}`
	if (distTags[explicitKey]) return explicitKey
	if (distTags.latest) {
		const lm = distTags.latest.match(/^(\d+)\.(\d+)\./)
		if (lm && lm[1] === maj && lm[2] === min) return 'latest'
	}
	return null
}

// ---------- sandstone update check ----------

import { sandstoneMinorToMCString } from './utils/sandstoneToMC.js'

export async function runUpdateCheck(projectDir: string): Promise<SandstoneUpdateInfo | null> {
	const installed = await readInstalledSandstoneVersion(projectDir)
	if (!installed) return null

	const data = await fetchNpmPackage('sandstone')
	if (!data) return null

	const channel = resolveChannel(data['dist-tags'], installed, 'sandstone')
	if (channel == null) return null

	const available = data['dist-tags'][channel]
	if (!available || available === installed) return null

	const pm = await detectLocalPM(projectDir)
	const command = localAddCommand(pm, `sandstone@^${available}`)

	const minorMatch = installed.match(/^(\d+)\.(\d+)/)
	const mcInstalled = minorMatch ? sandstoneMinorToMCString(parseInt(minorMatch[2]!, 10)) : 'unknown'

	return {
		installed,
		channel,
		available,
		command,
		mcInstalled,
	}
}

// ---------- CLI version + cross-instance detection ----------

import { CLI_VERSION } from './version.js'

interface CLIRuntimeContext {
	instance: 'workspace' | 'global' | 'unknown'
	entryPath: string | null
}

async function detectCLIRuntime(): Promise<CLIRuntimeContext> {
	let entryPath: string | null = null
	try {
		const metaAny = import.meta as unknown as { path?: string; url?: string }
		entryPath = metaAny.path ?? (metaAny.url ? new URL(metaAny.url).pathname : null) ?? null
	} catch {
		entryPath = process.argv[1] ?? null
	}
	if (!entryPath) return { instance: 'unknown', entryPath: null }

	let dir = path.dirname(entryPath)
	for (let i = 0; i < 8; i++) {
		const candidate = path.join(dir, 'package.json')
		if (await fileExists(candidate)) {
			try {
				const raw = await fs.readFile(candidate, 'utf8')
				const pkg = JSON.parse(raw) as { name?: string }
				if (pkg.name === 'sandstone-cli') {
					return { instance: 'workspace', entryPath: candidate }
				}
			} catch {
				// ignore
			}
		}
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return { instance: 'global', entryPath }
}

async function findSandstoneWorkspaceFromCwd(): Promise<string | null> {
	let dir = process.cwd()
	for (let i = 0; i < 8; i++) {
		if (await fileExists(path.join(dir, 'sandstone.code-workspace'))) return dir
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

async function readCLIVersionFromDir(dir: string): Promise<string | null> {
	try {
		const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8')
		const pkg = JSON.parse(raw) as { version?: string }
		return pkg.version ?? null
	} catch {
		return null
	}
}

async function shellescapeSandVersion(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('sand', ['--version'])
		const out = stdout.trim()
		const m = out.match(/(\d+\.\d+\.\d+)/)
		return m ? m[1]! : null
	} catch {
		return null
	}
}

export async function runSelfUpdateCheck(): Promise<CLIUpdateInfo | null> {
	const ctx = await detectCLIRuntime()
	const selfVersion = CLI_VERSION
	const selfSource: 'global' | 'workspace' = ctx.instance === 'workspace' ? 'workspace' : 'global'

	const npm = await fetchNpmPackage('sandstone-cli')
	if (!npm) return null
	const latest = npm['dist-tags']?.latest
	if (!latest || latest === selfVersion) return null

	const sandPath = await findSandBinaryPath()
	const globalPM: GlobalPM = sandPath ? classifyGlobalSandPath(sandPath) : 'unknown'
	const command = globalAddCommand(globalPM, `sandstone-cli@^${latest}`)

	return {
		installed: selfVersion,
		available: latest,
		command,
		source: selfSource,
	}
}

/**
 * Cross-instance check: workspace CLI checks global, global CLI checks workspace.
 */
export interface CrossInstanceUpdateInfo extends CLIUpdateInfo {
	targetInstance: 'global' | 'workspace'
	hint?: string
}

export async function runCrossInstanceUpdateCheck(): Promise<CrossInstanceUpdateInfo | null> {
	const ctx = await detectCLIRuntime()
	const npm = await fetchNpmPackage('sandstone-cli')
	if (!npm) return null
	const latest = npm['dist-tags']?.latest
	if (!latest) return null

	if (ctx.instance === 'workspace') {
		const globalVer = await shellescapeSandVersion()
		if (!globalVer || globalVer === latest) return null
		const sandPath = await findSandBinaryPath()
		const globalPM = sandPath ? classifyGlobalSandPath(sandPath) : 'unknown'
		return {
			installed: globalVer,
			available: latest,
			command: globalAddCommand(globalPM, `sandstone-cli@^${latest}`),
			source: 'global',
			targetInstance: 'global',
		}
	} else {
		const workspace = await findSandstoneWorkspaceFromCwd()
		if (!workspace) return null
		const workspaceCLIVersion = await readCLIVersionFromDir(path.join(workspace, 'sandstone-cli'))
		if (!workspaceCLIVersion || workspaceCLIVersion === latest) return null
		return {
			installed: workspaceCLIVersion,
			available: latest,
			command: `bun dev:build:cli && bun dev:link (run from ${workspace})`,
			source: 'workspace',
			targetInstance: 'workspace',
			hint: `The workspace CLI build is behind. Rebuild with \`bun dev:build:cli\` in ${workspace}/sandstone-work and re-link.`,
		}
	}
}

// ---------- MC header (async; reads installed version) ----------

import { readFile as readFileAsync } from 'fs/promises'

export async function getMCHeaderAsync(projectDir: string): Promise<string | null> {
	let installed: string
	try {
		const raw = await readFileAsync(
			path.join(projectDir, 'node_modules', 'sandstone', 'package.json'),
			'utf8'
		)
		installed = (JSON.parse(raw) as { version: string }).version
	} catch {
		return null
	}
	const m = installed.match(/^(\d+)\.(\d+)/)
	if (!m) return null
	const minor = parseInt(m[2]!, 10)
	const mc = sandstoneMinorToMCString(minor)
	return `[sand] Building for Minecraft ${mc} (sandstone ${installed})`
}

// ---------- Combine ----------

export interface AggregatedCheck {
	sandstone: SandstoneUpdateInfo | null
	cli: CLIUpdateInfo | null
	cross: CrossInstanceUpdateInfo | null
}

export async function runAllUpdateChecks(projectDir: string): Promise<AggregatedCheck> {
	const [sandstone, cli, cross] = await Promise.all([
		runUpdateCheck(projectDir),
		runSelfUpdateCheck(),
		runCrossInstanceUpdateCheck(),
	])
	return { sandstone, cli, cross }
}

/**
 * Pure helper: convert an AggregatedCheck into the lines to print, or []
 * when there's nothing to show.
 */
export function aggregateToLines(agg: AggregatedCheck): string[] {
	const out: string[] = []
	if (agg.sandstone) out.push(agg.sandstone.command)
	if (agg.cli) out.push(agg.cli.command)
	if (agg.cross) out.push(agg.cross.command)
	return out
}
