import path from 'path'
import { format } from 'util'

import { detectPackageManager, sha256File } from '../utils/index.js'
import { logger, type LoggerSink } from '../utils/logger.js'
import * as fs from '../utils/fs.js'
import { run } from '../utils/shell.js'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

function setupConsoleSink() {
  logger.registerSink('console')
  const sink = logger.sinks.console
  sink.setLiveCallback((level, args) => {
    const text = args.map((a) => (typeof a === 'string' ? a : format(a))).join(' ')
    if (level) process.stdout.write(`[${level}] ${text}\n`)
    else process.stdout.write(text + '\n')
  })
  return sink
}

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

function pmPackCmd(pm: PackageManager): [string, string[]] {
  switch (pm) {
    case 'npm': return ['npm', ['pack']]
    case 'pnpm': return ['pnpm', ['pack']]
    case 'yarn': return ['yarn', ['pack']]
    case 'bun': return ['bun', ['pm', 'pack']]
  }
}

function pmAddCmd(pm: PackageManager, spec: string): [string, string[]] {
  return [pm, ['install', spec]]
}

function pmRemoveCmd(pm: PackageManager, name: string): [string, string[]] {
  return [pm, ['uninstall', name]]
}

async function runPm(cmd: [string, string[]], cwd: string): Promise<void> {
  await run(cmd[0], cmd[1], { cwd, stdio: 'inherit', throws: true })
}

async function isInstalled(projectPath: string, name: string): Promise<boolean> {
  return fs.pathExists(path.join(projectPath, 'node_modules', name))
}

async function readDepVersion(projectPath: string, name: string): Promise<string | undefined> {
  const pkgPath = path.join(projectPath, 'package.json')
  if (!(await fs.pathExists(pkgPath))) return undefined
  const pkg = JSON.parse(await fs.readText(pkgPath))
  const spec = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name]
  if (!spec) return undefined
  if (spec.startsWith('file:') || spec.startsWith('link:') || spec.endsWith('.tgz')) return undefined
  return spec
}

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
  const tarballName = pkgName.startsWith('@') ? pkgName.slice(1).replace('/', '-') : pkgName
  const version = (typeof pkg.version === 'string' && pkg.version.length > 0) ? pkg.version : '0.0.0'
  const basename = path.basename(abs)
  const producedName = `${tarballName}-${version}.tgz`
  const producedPath = path.join(abs, producedName)

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

export async function repackIfLinked(libraryPath: string): Promise<PackResult | null> {
  const abs = path.resolve(libraryPath)
  const versionFile = path.join(abs, '.sandstone', LINK_VERSION_FILENAME)
  if (!(await fs.pathExists(versionFile))) return null
  return packLibrary(abs)
}

async function linkConsumer(projectPath: string, libraryPath: string, sink: LoggerSink): Promise<void> {
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

  for (const [oldName, oldEntry] of Object.entries(data.links)) {
    if (oldName === packageName) continue
    if (oldEntry.libraryPath === libAbs) {
      delete data.links[oldName]
    }
  }
  if (existing && existing.currentHash === currentHash && (await isInstalled(projectAbs, packageName))) {
    sink.log(`[link] ${packageName} is already linked and up to date.`)
    return
  }

  const pm = await detectPackageManager(projectAbs)
  if (!pm) {
    throw new Error(`No package manager lockfile in ${projectAbs}. Run a package manager install first.`)
  }
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

  sink.log(`[link] Linked ${packageName} from ${libAbs}.`)
}

export async function syncLinkedLibraries(projectPath: string, sink: LoggerSink): Promise<number> {
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
      sink.logWarn(`[link] Library "${name}" at ${entry.libraryPath} is missing its tarball or link_version. Dropping stale entry.`)
      delete data.links[name]
      dropped++
      continue
    }

    const currentHash = (await fs.readText(versionFile)).trim()
    if (currentHash === entry.currentHash) continue

    const pm = await detectPackageManager(abs)
    if (!pm) {
      sink.logWarn(`[link] No package manager lockfile in ${abs}; cannot sync ${name}.`)
      continue
    }

    sink.log(`[link] ${name} changed (${entry.currentHash.slice(0, 8)} → ${currentHash.slice(0, 8)}). Reinstalling...`)

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

async function unlinkProject(projectPath: string, target: string, sink: LoggerSink): Promise<void> {
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
      sink.log(`[link] Restoring ${entry.packageName} to ${entry.previousVersion}...`)
      await runPm(pmAddCmd(pm, `${entry.packageName}@${entry.previousVersion}`), projectAbs)
    } else {
      sink.log(`[link] Removing ${entry.packageName}...`)
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
  sink.log(`[link] Unlinked ${entry.packageName}.`)
}

async function unlinkLibrary(libraryPath: string, sink: LoggerSink): Promise<void> {
  const abs = path.resolve(libraryPath)
  const sandstoneDir = path.join(abs, '.sandstone')
  if (!(await fs.pathExists(sandstoneDir))) {
    sink.log(`[link] No .sandstone directory in ${abs}; nothing to unlink.`)
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

  sink.log(`[link] Unlinked library at ${abs} (removed ${removed} files).`)
}

export type LinkCommandOptions = {
  path: string
  libraryPath?: string
}

export async function linkCommand(opts: LinkCommandOptions): Promise<void> {
  const sink = setupConsoleSink()
  try {
    if (opts.libraryPath) {
      await linkConsumer(opts.path, opts.libraryPath, sink)
    } else {
      const result = await packLibrary(opts.path)
      sink.log(`[link] Packed ${result.name}. Tarball: ${result.tarballPath}`)
    }
  } catch (err) {
    sink.logError(err)
    process.exit(1)
  }
}

export type UnlinkCommandOptions = {
  path: string
  target?: string
}

export async function unlinkCommand(opts: UnlinkCommandOptions): Promise<void> {
  const sink = setupConsoleSink()
  try {
    if (opts.target) {
      await unlinkProject(opts.path, opts.target, sink)
    } else {
      await unlinkLibrary(opts.path, sink)
    }
  } catch (err) {
    sink.logError(err)
    process.exit(1)
  }
}
