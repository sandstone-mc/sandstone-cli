import path from 'path'

import { detectPackageManager, sha256File } from '../utils/index.js'
import { initLoggerNoFile, log, logWarn, logError } from '../ui/logger.js'
import * as fs from '../utils/fs.js'
import { run } from '../utils/shell.js'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

type LinkEntry = {
  packageName: string
  libraryPath: string
  tarballPath: string
  currentHash: string
  previousVersion?: string
}

type LinksFile = {
  links: Record<string, LinkEntry>
}

const LINKS_FILENAME = 'links.json'
const LINK_VERSION_FILENAME = 'link_version'

// --- Links file IO ---------------------------------------------------------

async function readLinksFile(projectPath: string): Promise<LinksFile> {
  const file = path.join(projectPath, '.sandstone', LINKS_FILENAME)
  try {
    const raw = JSON.parse(await fs.readText(file))
    if (raw && typeof raw === 'object' && raw.links && typeof raw.links === 'object') {
      return raw as LinksFile
    }
  } catch {}
  return { links: {} }
}

async function writeLinksFile(projectPath: string, data: LinksFile): Promise<void> {
  const file = path.join(projectPath, '.sandstone', LINKS_FILENAME)
  await fs.ensureDir(path.dirname(file))
  await fs.writeJSON(file, data)
}

// --- PM command maps -------------------------------------------------------

function pmPackCmd(pm: PackageManager): [string, string[]] {
  switch (pm) {
    case 'npm': return ['npm', ['pack']]
    case 'pnpm': return ['pnpm', ['pack']]
    case 'yarn': return ['yarn', ['pack']]
    case 'bun': return ['bun', ['pm', 'pack']]
  }
}

function pmAddCmd(pm: PackageManager, spec: string): [string, string[]] {
  // `install <pkg>` works as an alias for `add <pkg>` on all four PMs.
  return [pm, ['install', spec]]
}

function pmRemoveCmd(pm: PackageManager, name: string): [string, string[]] {
  return [pm, ['uninstall', name]]
}

async function runPm(cmd: [string, string[]], cwd: string): Promise<void> {
  // `stdio: 'inherit'` keeps the PM's stdout visible to the user — installs
  // are interactive, the CLI shouldn't try to swallow their progress.
  await run(cmd[0], cmd[1], { cwd, stdio: 'inherit', throws: true })
}

// --- Helpers ---------------------------------------------------------------

async function isInstalled(projectPath: string, name: string): Promise<boolean> {
  return fs.pathExists(path.join(projectPath, 'node_modules', name))
}

async function readDepVersion(projectPath: string, name: string): Promise<string | undefined> {
  const pkgPath = path.join(projectPath, 'package.json')
  if (!(await fs.pathExists(pkgPath))) return undefined
  const pkg = JSON.parse(await fs.readText(pkgPath))
  const spec = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name]
  // Only treat "real" version specs (semver, tag, registry version) as a
  // previous version worth restoring. Tarball paths and `file:`/`link:`
  // specs are not valid restore targets — restoring to them would be a
  // no-op or re-install the same tarball we just unlinked.
  if (!spec) return undefined
  if (spec.startsWith('file:') || spec.startsWith('link:') || spec.endsWith('.tgz')) return undefined
  return spec
}

// --- Library pack ----------------------------------------------------------

export type PackResult = {
  name: string
  hash: string
  tarballPath: string
  libraryPath: string
}

export async function packLibrary(libraryPath: string): Promise<PackResult> {
  const abs = path.resolve(libraryPath)
  const pm = await detectPackageManager(abs)
  if (!pm) {
    throw new Error(`No package manager lockfile found in ${abs}. Run a package manager install first.`)
  }

  const pkgPath = path.join(abs, 'package.json')
  if (!(await fs.pathExists(pkgPath))) {
    throw new Error(`No package.json in ${abs}`)
  }
  const pkg = JSON.parse(await fs.readText(pkgPath))
  const pkgName = (typeof pkg.name === 'string' && pkg.name.length > 0) ? pkg.name : path.basename(abs)
  // For scoped names (`@scope/name`), `npm pack` / `bun pm pack` produce
  // a flat filename with the slash replaced by a hyphen (`scope-name`).
  const tarballName = pkgName.startsWith('@') ? pkgName.slice(1).replace('/', '-') : pkgName
  const version = (typeof pkg.version === 'string' && pkg.version.length > 0) ? pkg.version : '0.0.0'
  const basename = path.basename(abs)
  const producedName = `${tarballName}-${version}.tgz`
  const producedPath = path.join(abs, producedName)

  // Pre-clean any prior pack output to avoid stale interference
  if (await fs.pathExists(producedPath)) {
    await fs.remove(producedPath)
  }

  const cmd = pmPackCmd(pm)
  await runPm(cmd, abs)

  if (!(await fs.pathExists(producedPath))) {
    throw new Error(`Pack did not produce expected ${producedName} (PM: ${pm})`)
  }

  const sandstoneDir = path.join(abs, '.sandstone')
  await fs.ensureDir(sandstoneDir)
  const dest = path.join(sandstoneDir, `${basename}.tgz`)
  await fs.move(producedPath, dest, { overwrite: true })

  const hash = await sha256File(dest)
  await fs.writeText(path.join(sandstoneDir, LINK_VERSION_FILENAME), hash)

  return { name: basename, hash, tarballPath: dest, libraryPath: abs }
}

/**
 * Repack the library only if the user has opted in by writing
 * `.sandstone/link_version` (via `sand link` in library mode). Used by
 * `watch --library` to keep the tarball in sync after a `bun dev:build`.
 */
export async function repackIfLinked(libraryPath: string): Promise<PackResult | null> {
  const abs = path.resolve(libraryPath)
  const versionFile = path.join(abs, '.sandstone', LINK_VERSION_FILENAME)
  if (!(await fs.pathExists(versionFile))) return null
  return packLibrary(abs)
}

// --- Consumer link ---------------------------------------------------------

async function linkConsumer(projectPath: string, libraryPath: string): Promise<void> {
  const projectAbs = path.resolve(projectPath)
  const libAbs = path.resolve(libraryPath)

  const libPkg = path.join(libAbs, 'package.json')
  if (!(await fs.pathExists(libPkg))) {
    throw new Error(`No package.json at ${libAbs}. Is that a library?`)
  }

  const versionFile = path.join(libAbs, '.sandstone', LINK_VERSION_FILENAME)
  if (!(await fs.pathExists(versionFile))) {
    throw new Error(`Library at ${libAbs} is not linked yet. Run "sand link" in that directory first.`)
  }
  const currentHash = (await fs.readText(versionFile)).trim()
  const tarballPath = path.join(libAbs, '.sandstone', `${path.basename(libAbs)}.tgz`)
  if (!(await fs.pathExists(tarballPath))) {
    throw new Error(`Library at ${libAbs} is missing its tarball. Run "sand link" there again.`)
  }

  const data = await readLinksFile(projectAbs)
  const pkg = JSON.parse(await fs.readText(libPkg))
  const packageName = (typeof pkg.name === 'string' && pkg.name.length > 0) ? pkg.name : path.basename(libAbs)
  const existing = data.links[packageName]

  // Garbage-collect any orphan entries pointing at the same library under
  // an older name. Happens when the library renames itself in package.json
  // between links (repo rename, scope change, etc.) — without this, the old
  // key survives forever and `sand unlink` can only find it by path.
  for (const [oldName, oldEntry] of Object.entries(data.links)) {
    if (oldName === packageName) continue
    if (oldEntry.libraryPath === libAbs) {
      delete data.links[oldName]
    }
  }

  // Idempotency: hash matches and lib is installed → no-op
  if (existing && existing.currentHash === currentHash && (await isInstalled(projectAbs, packageName))) {
    log(`[link] ${packageName} is already linked and up to date.`)
    return
  }

  const pm = await detectPackageManager(projectAbs)
  if (!pm) {
    throw new Error(`No package manager lockfile in ${projectAbs}. Run a package manager install first.`)
  }

  // Preserve the original previousVersion across re-links; only capture if
  // this is the first time we link this name. `readDepVersion` filters out
  // tarball/file: specs, but `existing?.previousVersion` might pre-date
  // that filter, so apply the same check here.
  let previousVersion = existing?.previousVersion
  if (previousVersion && (previousVersion.startsWith('file:') || previousVersion.startsWith('link:') || previousVersion.endsWith('.tgz'))) {
    previousVersion = undefined
  }
  if (!previousVersion) {
    previousVersion = await readDepVersion(projectAbs, packageName)
  }

  if (await isInstalled(projectAbs, packageName)) {
    await runPm(pmRemoveCmd(pm, packageName), projectAbs)
    const leftover = path.join(projectAbs, 'node_modules', packageName)
    if (await fs.pathExists(leftover)) {
      await fs.remove(leftover)
    }
  }
  await runPm(pmAddCmd(pm, tarballPath), projectAbs)

  data.links[packageName] = {
    packageName,
    libraryPath: libAbs,
    tarballPath,
    currentHash,
    previousVersion,
  }
  await writeLinksFile(projectAbs, data)

  log(`[link] Linked ${packageName} from ${libAbs}.`)
}

// --- Sync (called by build/watch) ------------------------------------------

export async function syncLinkedLibraries(projectPath: string): Promise<number> {
  const abs = path.resolve(projectPath)
  const linksFile = path.join(abs, '.sandstone', LINKS_FILENAME)
  if (!(await fs.pathExists(linksFile))) return 0

  const data = await readLinksFile(abs)
  let updated = 0
  let dropped = 0

  for (const [name, entry] of Object.entries(data.links)) {
    const versionFile = path.join(entry.libraryPath, '.sandstone', LINK_VERSION_FILENAME)
    const tarballPath = entry.tarballPath

    if (!(await fs.pathExists(versionFile)) || !(await fs.pathExists(tarballPath))) {
      // Library moved or was `sand unlink`-ed from its own directory — the
      // entry points at a tarball/version file that no longer exists. Drop
      // it so we don't warn-skip the same ghost on every rebuild.
      logWarn(`[link] Library "${name}" at ${entry.libraryPath} is missing its tarball or link_version. Dropping stale entry.`)
      delete data.links[name]
      dropped++
      continue
    }

    const currentHash = (await fs.readText(versionFile)).trim()
    if (currentHash === entry.currentHash) continue

    const pm = await detectPackageManager(abs)
    if (!pm) {
      logWarn(`[link] No package manager lockfile in ${abs}; cannot sync ${name}.`)
      continue
    }

    log(`[link] ${name} changed (${entry.currentHash.slice(0, 8)} → ${currentHash.slice(0, 8)}). Reinstalling...`)

    if (await isInstalled(abs, entry.packageName)) {
      await runPm(pmRemoveCmd(pm, entry.packageName), abs)
      const leftover = path.join(abs, 'node_modules', entry.packageName)
      if (await fs.pathExists(leftover)) {
        await fs.remove(leftover)
      }
    }
    await runPm(pmAddCmd(pm, tarballPath), abs)

    entry.currentHash = currentHash
    updated++
  }

  if (updated > 0 || dropped > 0) {
    await writeLinksFile(abs, data)
  }
  return updated
}

// --- Unlink (project) ------------------------------------------------------

async function unlinkProject(projectPath: string, target: string): Promise<void> {
  const projectAbs = path.resolve(projectPath)
  const data = await readLinksFile(projectAbs)

  let name: string | undefined
  let entry: LinkEntry | undefined

  if (Object.hasOwn(data.links, target)) {
    name = target
    entry = data.links[target]
  } else {
    // Try as path
    const targetAbs = path.resolve(target)
    for (const [n, e] of Object.entries(data.links)) {
      if (e.libraryPath === targetAbs) {
        name = n
        entry = e
        break
      }
    }
  }

  if (!name || !entry) {
    const known = Object.keys(data.links).join(', ') || '(none)'
    throw new Error(`No link found for "${target}". Known: ${known}`)
  }

  const pm = await detectPackageManager(projectAbs)
  if (!pm) {
    throw new Error(`No package manager lockfile in ${projectAbs}.`)
  }

  if (await isInstalled(projectAbs, entry.packageName)) {
    if (entry.previousVersion) {
      log(`[link] Restoring ${entry.packageName} to ${entry.previousVersion}...`)
      await runPm(pmAddCmd(pm, `${entry.packageName}@${entry.previousVersion}`), projectAbs)
    } else {
      log(`[link] Removing ${entry.packageName}...`)
      await runPm(pmRemoveCmd(pm, entry.packageName), projectAbs)
      // Some PMs (notably bun) don't actually delete `node_modules/<name>`
      // when removing a tarball/file: dep. Clean up manually so the
      // unlink is fully reversible.
      const leftover = path.join(projectAbs, 'node_modules', entry.packageName)
      if (await fs.pathExists(leftover)) {
        await fs.remove(leftover)
      }
    }
  }

  delete data.links[name]
  await writeLinksFile(projectAbs, data)
  log(`[link] Unlinked ${entry.packageName}.`)
}

// --- Unlink (library) ------------------------------------------------------

async function unlinkLibrary(libraryPath: string): Promise<void> {
  const abs = path.resolve(libraryPath)
  const sandstoneDir = path.join(abs, '.sandstone')
  if (!(await fs.pathExists(sandstoneDir))) {
    log(`[link] No .sandstone directory in ${abs}; nothing to unlink.`)
    return
  }

  let removed = 0
  const entries = await fs.readDirNames(sandstoneDir)
  for (const e of entries) {
    if (e.endsWith('.tgz')) {
      await fs.remove(path.join(sandstoneDir, e))
      removed++
    }
  }
  const versionFile = path.join(sandstoneDir, LINK_VERSION_FILENAME)
  if (await fs.pathExists(versionFile)) {
    await fs.remove(versionFile)
    removed++
  }

  log(`[link] Unlinked library at ${abs} (removed ${removed} files).`)
}

// --- Command handlers ------------------------------------------------------

export type LinkCommandOptions = {
  path: string
  libraryPath?: string
}

export async function linkCommand(opts: LinkCommandOptions): Promise<void> {
  initLoggerNoFile()
  try {
    if (opts.libraryPath) {
      await linkConsumer(opts.path, opts.libraryPath)
    } else {
      const result = await packLibrary(opts.path)
      log(`[link] Packed ${result.name}. Tarball: ${result.tarballPath}`)
    }
  } catch (err) {
    logError(err)
    process.exit(1)
  }
}

export type UnlinkCommandOptions = {
  path: string
  target?: string
}

export async function unlinkCommand(opts: UnlinkCommandOptions): Promise<void> {
  initLoggerNoFile()
  try {
    if (opts.target) {
      await unlinkProject(opts.path, opts.target)
    } else {
      await unlinkLibrary(opts.path)
    }
  } catch (err) {
    logError(err)
    process.exit(1)
  }
}
