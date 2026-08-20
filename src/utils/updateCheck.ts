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
 * All filesystem and shell calls use async APIs (utils/fs Bun-based +
 * utils/shell `run()` wrapper) so we never block the event loop.
 */

import * as fs from './fs.js'
import { run } from './shell.js'
import { sandstoneMinorToMCString } from './index.js'
import path from 'path'

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
  command: string // PM-adjusted install command for wherever this CLI lives
  source: CLIInstance
}

/**
 * Where a `sand` binary lives:
 *   - `project` — a dependency in the user's project `node_modules`
 *   - `global`  — a global PM install (`bun add -g`, `npm i -g`, …)
 */
export type CLIInstance = 'project' | 'global' | 'unknown'

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
    const raw = await fs.readText(pkgPath)
    const pkg = JSON.parse(raw) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

// ---------- PM detection (project level) ----------

type LocalPM = 'bun' | 'pnpm' | 'yarn' | 'npm'

export async function detectLocalPM(projectDir: string): Promise<LocalPM> {
  // Runtime check: if we're executing under Bun, treat it as the user's PM
  // regardless of which lockfile happens to be in the directory. A user's
  // project can contain a stale `package-lock.json` from a one-off `npm i`
  // while they normally run everything through `bun` — the runtime is the
  // ground truth, the lockfile is a hint.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return 'bun'
  if (await fs.pathExists(path.join(projectDir, 'bun.lock')) || await fs.pathExists(path.join(projectDir, 'bun.lockb'))) return 'bun'
  if (await fs.pathExists(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await fs.pathExists(path.join(projectDir, 'yarn.lock'))) return 'yarn'
  if (await fs.pathExists(path.join(projectDir, 'package-lock.json'))) return 'npm'
  return 'npm'
}

function localAddCommand(pm: LocalPM, spec: string, dev = false): string {
  switch (pm) {
    case 'bun':
      return `bun add ${dev ? '--dev ' : ''}${spec}`
    case 'pnpm':
      return `pnpm add ${dev ? '--save-dev ' : ''}${spec}`
    case 'yarn':
      return `yarn add ${dev ? '--dev ' : ''}${spec}`
    case 'npm':
      return `npm install ${dev ? '--save-dev ' : ''}${spec}`
  }
}

/**
 * Whether a package sits in the project's `devDependencies`.
 *
 * Drives the `--dev` flag on the suggested add command, so the suggestion
 * doesn't silently move the dep between sections. `sandstone-cli` is always a
 * devDependency; `sandstone` is a devDependency in the library template but a
 * regular dependency in the pack template — read it rather than assume.
 */
async function isDevDependency(projectDir: string, packageName: string): Promise<boolean> {
  try {
    const raw = await fs.readText(path.join(projectDir, 'package.json'))
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    if (pkg.dependencies?.[packageName]) return false
    return Boolean(pkg.devDependencies?.[packageName])
  } catch {
    return false
  }
}

// ---------- PM detection (global level, via `which sand`/`where sand`) ----------

type GlobalPM = 'bun' | 'pnpm' | 'yarn' | 'npm' | 'unknown'

function isWindows(): boolean {
  return process.platform === 'win32'
}

function normalizeSlashes(p: string): string {
  return p.replaceAll('\\', '/')
}

function isInsideLocalBin(p: string): boolean {
  return normalizeSlashes(p).toLowerCase().includes('node_modules/.bin')
}

/**
 * Env whose PATH has every `node_modules/.bin` entry stripped.
 *
 * Package-manager run scripts (`bun run`, `npm run`, …) prepend the project's
 * `node_modules/.bin` to PATH. A bare `which sand` / `sand --version` from
 * inside a run script therefore resolves to the *project-local* CLI — the one
 * already executing — instead of the global install we're trying to inspect.
 * Strip those entries so global lookups really do look at the global install.
 */
function globalLookupEnv(): NodeJS.ProcessEnv {
  const sep = isWindows() ? ';' : ':'
  // Windows env keys are case-insensitive; find whichever casing is present.
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  const cleaned = (process.env[pathKey] ?? '')
    .split(sep)
    .filter(entry => entry.length > 0 && !isInsideLocalBin(entry))
    .join(sep)
  return { ...process.env, [pathKey]: cleaned }
}

async function findGlobalSandBinaryPath(): Promise<string | null> {
  const cmd = isWindows() ? 'where' : 'which'
  try {
    // `which`/`where` write the resolved path to stdout — let the shell
    // wrapper capture it.
    const result = await run(cmd, ['sand'], { env: globalLookupEnv(), throws: false })
    const hit = (await result.stdout)
      .toString()
      .split('\n')
      .map(line => line.trim())
      .find(line => line.length > 0 && !isInsideLocalBin(line))
    return hit ?? null
  } catch {
    return null
  }
}

function classifyGlobalSandPath(p: string): GlobalPM {
  // Same ground-truth rule as detectLocalPM: if this process is running under
  // Bun, the user's global install was almost certainly `bun add -g …` even
  // if the binary path doesn't carry a `.bun/` segment (PATH-style installs
  // or unusual prefixes won't match the substring test below).
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return 'bun'
  const lower = normalizeSlashes(p).toLowerCase()
  if (lower.includes('.bun/') || lower.includes('/bun/')) return 'bun'
  if (lower.includes('pnpm')) return 'pnpm'
  if (lower.includes('yarn')) return 'yarn'
  if (lower.includes('node_modules') || lower.includes('/npm/')) return 'npm'
  return 'unknown'
}

/**
 * `fallback` is the PM detected for the user's project — a far better guess
 * than hardcoding npm when the global binary's path is unrecognizable.
 */
function globalAddCommand(pm: GlobalPM, spec: string, fallback: LocalPM = 'npm'): string {
  const resolved: LocalPM = pm === 'unknown' ? fallback : pm
  switch (resolved) {
    case 'bun':
      return `bun add -g ${spec}`
    case 'pnpm':
      return `pnpm add -g ${spec}`
    case 'yarn':
      return `yarn global add ${spec}`
    case 'npm':
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
  // For non-latest channels, pin to the per-minor dist-tag (e.g.
  // `sandstone-1-0`) so a v1.0.x install stays in v1.0.x. For the latest
  // channel, use `~` so the install stays on the current minor even after
  // a new minor ships — `^1.2.23` would resolve to >=1.2.23 <2.0.0 and
  // pull 1.3.x once 1.3 lands.
  const spec = channel === 'latest' ? `sandstone@~${available}` : `sandstone@${channel}`
  const command = localAddCommand(
    pm,
    spec,
    await isDevDependency(projectDir, 'sandstone'),
  )

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

import { CLI_VERSION } from '../version.js'

interface CLIRuntimeContext {
  instance: CLIInstance
  entryPath: string | null
}

function currentEntryPath(): string | null {
  try {
    const metaAny = import.meta as unknown as { path?: string; url?: string }
    return metaAny.path
      ?? (metaAny.url ? new URL(metaAny.url).pathname : null)
      ?? process.argv[1]
      ?? null
  } catch {
    return process.argv[1] ?? null
  }
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p) as unknown as string
  } catch {
    return p
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Classify which copy of the CLI is executing.
 *
 * The previous implementation walked up to the nearest `package.json` named
 * `sandstone-cli` and treated any hit as a dev checkout — but an ordinary
 * `node_modules/sandstone-cli` install satisfies that too, so a plain project
 * devDependency was misclassified.
 *
 * Decide by location instead: is the entry path under the project's
 * `node_modules`? Checked both as-given and realpath'd, so a symlinked install
 * still resolves to `project`.
 */
async function detectCLIRuntime(projectDir: string): Promise<CLIRuntimeContext> {
  const entryPath = currentEntryPath()
  if (!entryPath) return { instance: 'unknown', entryPath: null }

  const projectModules = path.join(projectDir, 'node_modules')
  const realProjectModules = path.join(await realpathOrSelf(projectDir), 'node_modules')
  const realEntry = await realpathOrSelf(entryPath)

  if (
    isInside(entryPath, projectModules)
    || isInside(realEntry, realProjectModules)
  ) {
    return { instance: 'project', entryPath: realEntry }
  }

  return { instance: 'global', entryPath: realEntry }
}

async function readCLIVersionFromDir(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readText(path.join(dir, 'package.json'))
    const pkg = JSON.parse(raw) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

/**
 * Version of the *global* `sand`, via a PATH with `node_modules/.bin` stripped
 * so we don't just re-read the project-local CLI that's already running.
 */
async function readGlobalSandVersion(): Promise<string | null> {
  try {
    const result = await run('sand', ['--version'], { env: globalLookupEnv(), throws: false })
    const m = (await result.stdout).toString().trim().match(/(\d+\.\d+\.\d+)/)
    return m ? m[1]! : null
  } catch {
    return null
  }
}

/** Suggested command to bring the global `sand` up to `version`. */
async function globalUpdateCommand(version: string, fallback: LocalPM): Promise<string> {
  const sandPath = await findGlobalSandBinaryPath()
  const pm: GlobalPM = sandPath ? classifyGlobalSandPath(sandPath) : 'unknown'
  return globalAddCommand(pm, `sandstone-cli@^${version}`, fallback)
}

/** Suggested command to bring the project's `sandstone-cli` up to `version`. */
async function projectCLIUpdateCommand(projectDir: string, version: string): Promise<string> {
  const pm = await detectLocalPM(projectDir)
  return localAddCommand(
    pm,
    `sandstone-cli@^${version}`,
    await isDevDependency(projectDir, 'sandstone-cli'),
  )
}

export async function runSelfUpdateCheck(projectDir: string): Promise<CLIUpdateInfo | null> {
  const ctx = await detectCLIRuntime(projectDir)

  const npm = await fetchNpmPackage('sandstone-cli')
  if (!npm) return null
  const latest = npm['dist-tags']?.latest
  if (!latest || latest === CLI_VERSION) return null

  const command = ctx.instance === 'project'
    ? await projectCLIUpdateCommand(projectDir, latest)
    : await globalUpdateCommand(latest, await detectLocalPM(projectDir))

  return {
    installed: CLI_VERSION,
    available: latest,
    command,
    source: ctx.instance === 'project' ? 'project' : 'global',
  }
}

/**
 * Cross-instance check: the running CLI reports on the *other* install, so a
 * stale global doesn't hide behind an up-to-date project copy (or vice versa).
 */
export interface CrossInstanceUpdateInfo extends CLIUpdateInfo {
  targetInstance: 'global' | 'project'
}

export async function runCrossInstanceUpdateCheck(projectDir: string): Promise<CrossInstanceUpdateInfo | null> {
  const ctx = await detectCLIRuntime(projectDir)
  if (ctx.instance === 'unknown') return null

  const npm = await fetchNpmPackage('sandstone-cli')
  if (!npm) return null
  const latest = npm['dist-tags']?.latest
  if (!latest) return null

  if (ctx.instance === 'global') {
    const projectVer = await readCLIVersionFromDir(path.join(projectDir, 'node_modules', 'sandstone-cli'))
    if (!projectVer || projectVer === latest) return null
    return {
      installed: projectVer,
      available: latest,
      command: await projectCLIUpdateCommand(projectDir, latest),
      source: 'project',
      targetInstance: 'project',
    }
  }

  const globalVer = await readGlobalSandVersion()
  if (!globalVer || globalVer === latest) return null
  return {
    installed: globalVer,
    available: latest,
    command: await globalUpdateCommand(latest, await detectLocalPM(projectDir)),
    source: 'global',
    targetInstance: 'global',
  }
}

// ---------- MC header (async; reads installed version) ----------

export async function getMCHeaderAsync(projectDir: string): Promise<string | null> {
  let installed: string
  try {
    const raw = await fs.readText(
      path.join(projectDir, 'node_modules', 'sandstone', 'package.json')
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
    runSelfUpdateCheck(projectDir),
    runCrossInstanceUpdateCheck(projectDir),
  ])
  return { sandstone, cli, cross }
}

/**
 * Pure helper: convert an AggregatedCheck into the lines to print, or []
 * when there's nothing to show.
 *
 * Deduplicated: the self and cross checks can legitimately land on the same
 * command (e.g. both installs are behind and share a package manager), and
 * printing it twice just looks broken.
 */
export function aggregateToLines(agg: AggregatedCheck): string[] {
  const out: string[] = []
  if (agg.sandstone) out.push(agg.sandstone.command)
  if (agg.cli) out.push(agg.cli.command)
  if (agg.cross) out.push(agg.cross.command)
  return [...new Set(out)]
}
