import path from 'node:path'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'

import * as fs from '../utils/fs.js'
import { loadSandstoneConfig } from '../utils/sandstoneConfig.js'

const PACK_TYPE = 'datapack'
const DEPS_PACK_TYPE = 'datapack_dependencies'

export type DeployWriteStream = (params: {
  path: string
  stream: ReadableStream<Uint8Array>
  size?: number
}) => Promise<{ done: Promise<{ bytesWritten: number }> }>

export interface DeployInput {
  daemon: {
    writeFileStream: DeployWriteStream
    executeRawCommand?: (params: { command: string }) => Promise<unknown>
    reloadResources?: () => Promise<void>
  }
  projectRoot: string
  outputDir?: string
  packName?: string
  /**
   * Pre-computed deploy check to reuse with `deployDatapack`. Lets the caller
   * (e.g. a UI that displays per-archive status) skip re-running
   * `checkDeployState` when the result is already in hand.
   */
  state?: DeployState
}

export interface DeployedDependency {
  name: string
  localPath: string
  remotePath: string
  bytesWritten: number
  unchanged: boolean
}

export interface DeployResult {
  archiveName: string
  archivePath: string
  remotePath: string
  bytesWritten: number
  unchanged: boolean
  dependencies: DeployedDependency[]
  reloaded: boolean
}

export type DepKind = 'folder' | 'zip'

export interface DeployStateEntry {
  kind: DepKind
  name: string
  sourceHash: string
  unchanged: boolean
}

export interface DeployState {
  packName?: string
  main?: DeployStateEntry
  folderDeps: DeployStateEntry[]
  zipDeps: DeployStateEntry[]
}

export interface CheckDeployInput {
  projectRoot: string
  outputDir?: string
  packName?: string
}

interface DeployCacheArchiveEntry {
  sourceHash: string
}

interface DeployCache {
  archives?: Record<string, DeployCacheArchiveEntry>
}

interface SandstoneCache {
  files?: Record<string, string>
}

async function readDeployCache(cacheFile: string): Promise<DeployCache> {
  try {
    const text = await fs.readText(cacheFile)
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && parsed.archives && !Array.isArray(parsed.archives)) {
      return parsed as DeployCache
    }
    return {}
  } catch {
    return {}
  }
}

async function writeDeployCache(cacheFile: string, cache: DeployCache): Promise<void> {
  await fs.ensureDir(path.dirname(cacheFile))
  await fs.writeText(cacheFile, JSON.stringify(cache))
}

async function readBuildCache(cacheFile: string): Promise<SandstoneCache> {
  try {
    const text = await fs.readText(cacheFile)
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && parsed.files) return parsed as SandstoneCache
    return {}
  } catch {
    return {}
  }
}

function hashFromBuildCache(files: Record<string, string>, prefix: string): string {
  const keys = Object.keys(files).filter((k) => k.startsWith(prefix))
  if (keys.length === 0) {
    throw new Error(
      `No build cache entries match prefix '${prefix}'. Run \`sand build\` (or start \`sand watch\`) before deploying.`,
    )
  }
  keys.sort()
  const hasher = createHash('md5')
  for (const k of keys) {
    hasher.update(`${k}|${files[k]}\n`)
  }
  return hasher.digest('hex')
}

interface DiscoveredDeps {
  folders: string[]
  zips: string[]
}

function discoverDeps(files: Record<string, string>): DiscoveredDeps {
  const prefix = `${DEPS_PACK_TYPE}/`
  const folderSet = new Set<string>()
  const zipSet = new Set<string>()
  for (const k of Object.keys(files)) {
    if (!k.startsWith(prefix)) continue
    const rest = k.slice(prefix.length)
    if (rest.includes('/')) {
      folderSet.add(rest.split('/')[0])
    } else {
      zipSet.add(rest)
    }
  }
  return { folders: [...folderSet], zips: [...zipSet] }
}

export async function checkDeployState(input: CheckDeployInput): Promise<DeployState> {
  const deployCacheFile = path.join(input.projectRoot, '.sandstone', 'deploy-cache.json')
  const buildCacheFile = path.join(input.projectRoot, '.sandstone', 'cache.json')

  const sandstoneConfig = await loadSandstoneConfig(input.projectRoot)
  const packName = input.packName ?? sandstoneConfig?.name

  const deployCache = await readDeployCache(deployCacheFile)
  const buildCache = await readBuildCache(buildCacheFile)
  const buildFiles = buildCache.files ?? {}

  let main: DeployStateEntry | undefined
  if (packName) {
    const name = `${packName}_${PACK_TYPE}.zip`
    const sourceHash = hashFromBuildCache(buildFiles, `${PACK_TYPE}/`)
    const cached = deployCache.archives?.[name]
    main = { kind: 'folder', name, sourceHash, unchanged: cached?.sourceHash === sourceHash }
  }

  const discovered = discoverDeps(buildFiles)
  const folderDeps: DeployStateEntry[] = []
  for (const folderName of discovered.folders) {
    const name = `${folderName}.zip`
    const sourceHash = hashFromBuildCache(buildFiles, `${DEPS_PACK_TYPE}/${folderName}/`)
    const cached = deployCache.archives?.[name]
    folderDeps.push({ kind: 'folder', name, sourceHash, unchanged: cached?.sourceHash === sourceHash })
  }
  const zipDeps: DeployStateEntry[] = []
  for (const zipName of discovered.zips) {
    const sourceHash = hashFromBuildCache(buildFiles, `${DEPS_PACK_TYPE}/${zipName}`)
    const cached = deployCache.archives?.[zipName]
    zipDeps.push({ kind: 'zip', name: zipName, sourceHash, unchanged: cached?.sourceHash === sourceHash })
  }

  return { packName, main, folderDeps, zipDeps }
}

async function ensureArchive(
  source: string,
  archiveName: string,
  archivePath: string,
  archivesDir: string,
  sourceHash: string,
  cache: DeployCache,
): Promise<{ archivePath: string; unchanged: boolean }> {
  const cachedEntry = cache.archives?.[archiveName]
  if (cachedEntry && cachedEntry.sourceHash === sourceHash && (await fs.pathExists(archivePath))) {
    return { archivePath, unchanged: true }
  }

  if (!(await fs.pathExists(source))) {
    throw new Error(
      `No source found at ${source}. Run \`sand build\` (or start \`sand watch\`) before deploying.`,
    )
  }

  const zip = new AdmZip()
  zip.addLocalFolder(source)
  await fs.ensureDir(archivesDir)
  zip.writeZip(archivePath)

  cache.archives ??= {}
  cache.archives[archiveName] = { sourceHash }
  return { archivePath, unchanged: false }
}

async function streamUpload(
  daemon: { writeFileStream: DeployWriteStream },
  remotePath: string,
  localPath: string,
): Promise<number> {
  const stat = await fs.fileStat(localPath)
  const stream = Bun.file(localPath).stream()
  const result = await daemon.writeFileStream({ path: remotePath, stream, size: stat.size })
  const { bytesWritten } = await result.done
  return bytesWritten
}

export async function deployDatapack(input: DeployInput): Promise<DeployResult> {
  const outputDir = input.outputDir ?? path.join(input.projectRoot, '.sandstone', 'output')
  const archivesDir = path.join(outputDir, 'archives')
  const deployCacheFile = path.join(input.projectRoot, '.sandstone', 'deploy-cache.json')

  const sandstoneConfig = await loadSandstoneConfig(input.projectRoot)
  if (!input.packName && !sandstoneConfig?.name) {
    throw new Error(
      `Cannot determine pack name. Set 'name' in sandstone.config.ts or pass --name to the deploy command.`,
    )
  }

  const deployCache = await readDeployCache(deployCacheFile)
  const state =
    input.state ??
    (await checkDeployState({
      projectRoot: input.projectRoot,
      outputDir: input.outputDir,
      packName: input.packName,
    }))
  let cacheDirty = false

  if (!state.main) {
    throw new Error(
      `No main datapack discovered. Run \`sand build\` (or start \`sand watch\`) before deploying.`,
    )
  }

  const mainEntry = state.main
  const mainArchivePath = path.join(archivesDir, mainEntry.name)
  const mainInfo = mainEntry.unchanged
    ? { archivePath: mainArchivePath, unchanged: true }
    : await ensureArchive(
        path.join(outputDir, PACK_TYPE),
        mainEntry.name,
        mainArchivePath,
        archivesDir,
        mainEntry.sourceHash,
        deployCache,
      )
  if (!mainInfo.unchanged) cacheDirty = true
  const mainRemotePath = path.join('world/datapacks', mainEntry.name)
  const mainBytes = mainInfo.unchanged ? 0 : await streamUpload(input.daemon, mainRemotePath, mainInfo.archivePath)

  const deps: DeployedDependency[] = []
  for (const dep of state.folderDeps) {
    const depArchivePath = path.join(archivesDir, dep.name)
    const depInfo = dep.unchanged
      ? { archivePath: depArchivePath, unchanged: true }
      : await ensureArchive(
          path.join(outputDir, DEPS_PACK_TYPE, dep.name.replace(/\.zip$/, '')),
          dep.name,
          depArchivePath,
          archivesDir,
          dep.sourceHash,
          deployCache,
        )
    if (!depInfo.unchanged) cacheDirty = true
    const depRemotePath = path.join('world/datapacks', dep.name)
    const depBytes = depInfo.unchanged ? 0 : await streamUpload(input.daemon, depRemotePath, depInfo.archivePath)
    deps.push({
      name: dep.name,
      localPath: depInfo.archivePath,
      remotePath: depRemotePath,
      bytesWritten: depBytes,
      unchanged: depInfo.unchanged,
    })
  }
  for (const dep of state.zipDeps) {
    const localPath = path.join(outputDir, DEPS_PACK_TYPE, dep.name)
    if (!dep.unchanged) {
      deployCache.archives ??= {}
      deployCache.archives[dep.name] = { sourceHash: dep.sourceHash }
      cacheDirty = true
    }
    const depRemotePath = path.join('world/datapacks', dep.name)
    const depBytes = dep.unchanged ? 0 : await streamUpload(input.daemon, depRemotePath, localPath)
    deps.push({
      name: dep.name,
      localPath,
      remotePath: depRemotePath,
      bytesWritten: depBytes,
      unchanged: dep.unchanged,
    })
  }

  if (cacheDirty) await writeDeployCache(deployCacheFile, deployCache)

  const anythingChanged = !mainInfo.unchanged || deps.some((d) => !d.unchanged)
  let reloaded = false
  if (anythingChanged && input.daemon.reloadResources) {
    await input.daemon.reloadResources().catch((err) => {
      throw new Error(
        `deployed but reload failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    reloaded = true
  }

  return {
    archiveName: mainEntry.name,
    archivePath: mainInfo.archivePath,
    remotePath: mainRemotePath,
    bytesWritten: mainBytes,
    unchanged: mainInfo.unchanged,
    dependencies: deps,
    reloaded,
  }
}