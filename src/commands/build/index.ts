import path from 'path'
import { pathToFileURL } from 'url'
import chalk from 'chalk'
import { split } from 'obliterator'

import type { BuildResult, ResourceCounts } from '../../ui/types.js'
import { log, logDebug, logError, logInfo, logWarn, initLoggerNoFile, initBuildLogger, setSilent } from '../../ui/logger.js'
import { hash } from '../../utils/index.js'
import * as fs from '../../utils/fs.js'
import { resolveStackTrace } from '../../utils/source-map.js'
import { syncLinkedLibraries } from '../link.js'
import { getMCHeaderAsync, runAllUpdateChecks, aggregateToLines } from '../../utils/updateCheck.js'

import {
  type SandstoneCache,
  checkSymlinksAvailable,
  getClientPath,
  getClientWorldPath,
  createArchive,
  preserveSymlink,
  exportPack,
  runExportHandler,
  getExportPath,
  cleanupOldSymlinks,
  cleanupOldArchives,
} from './export.js'

import {
  type FileExclusions,
  type FileHandler,
  autoRegisterPackTypes,
  processExternalResources,
} from './externalResources.js'

import type * as sandstone from 'sandstone'
import type { handlerReadFile, PackType } from 'sandstone/pack'

type SandstoneContext = ReturnType<typeof sandstone['getSandstoneContext']>

declare global {
  interface RegExpConstructor {
    escape(str: string): string;
  }
}

export type BuildOptions = {
  // Flags
  dry?: boolean
  verbose?: boolean
  root?: boolean
  strictErrors?: boolean
  production?: boolean
  debug?: boolean

  // Values
  path: string
  name?: string
  namespace?: string
  world?: string
  clientPath?: string
  serverPath?: string

  enableSymlinks?: boolean

  dependencies?: [string, string][]
}

export interface BuildContext {
  sandstoneConfig: sandstone.SandstoneConfig
  sandstonePack: sandstone.SandstonePack
  resetSandstonePack: () => void
}

// Cache management
let cache: SandstoneCache = { files: {} }

function loadCache(local: sandstone.BeforeSaveLocal): Promise<SandstoneCache> {
  if (Object.keys(cache.files).length > 0) {
    return Promise.resolve(cache)
  }

  return local.fs.readText(local.cacheFile).then((fileRead) => {
    if (fileRead) {
      const parsed = JSON.parse(fileRead)
      cache = parsed.files ? parsed : { files: parsed }
    }
  }).catch(() => {
    cache = { files: {} }
  }).then(() => cache)
}

function saveCache(local: sandstone.AfterAllLocal) {
  cache = local.newCache
  return local.fs.ensureDir(path.dirname(local.cacheFile)).then(() => local.fs.writeJSON(local.cacheFile, cache, { pretty: false }))
}

// Boilerplate resources to exclude from counts
const BOILERPLATE_NAMESPACES = new Set(['load', '__sandstone__'])
const BOILERPLATE_FUNCTIONS = new Set(['__init__'])
const BOILERPLATE_TAG = { namespace: 'minecraft', name: 'load' }

function isBoilerplateResource(resource: { path?: string[]; namespace?: string }): boolean {
  const ns = resource.namespace || ''
  const pathParts = resource.path || []
  const name = pathParts[pathParts.length - 1] || ''

  if (BOILERPLATE_NAMESPACES.has(ns)) return true
  if (BOILERPLATE_FUNCTIONS.has(name)) return true
  if (ns === BOILERPLATE_TAG.namespace && name === BOILERPLATE_TAG.name) return true

  return false
}

function countResources(sandstonePack: { core: { resourceNodes: Iterable<{ resource: unknown }> } }): ResourceCounts {
  let functions = 0
  let other = 0

  for (const node of sandstonePack.core.resourceNodes) {
    const resource = node.resource as { constructor?: { name?: string }; path?: string[]; namespace?: string }

    if (isBoilerplateResource(resource)) continue

    if (resource.constructor?.name === '_RawMCFunctionClass') {
      functions++
    } else {
      other++
    }
  }

  return { functions, other }
}

// Process pack type's generated output (post-processing)
async function processPackTypeOutput(
  local: sandstone.BeforeSaveLocal,
  packType: PackType,
  outputPath: string
) {
  await local.fs.ensureDir(outputPath)

  if (packType.handleOutput) {
    await packType.handleOutput(
      'output',
      async (relativePath: string, encoding: BufferEncoding = 'utf8') => {
        const fullPath = path.join(outputPath, relativePath)
        return fs.textFormats.has(encoding)
          ? local.fs.readText(fullPath)
          : local.fs.readBytes(fullPath)
      },
      async (relativePath: string, contents: any) => {
        if (contents === undefined) {
          await local.fs.unlinkPath(path.join(outputPath, relativePath))
        } else {
          await local.fs.writeBytes(
            path.join(outputPath, relativePath),
            contents instanceof ArrayBuffer ? Buffer.from(contents) : contents,
          )
        }
      },
    )
  }
}

export async function loadBuildContext(
  cliOptions: BuildOptions,
  _folder: string,
): Promise<BuildContext> {
  const folder = path.resolve(_folder)

  const configPath = path.join(folder, 'sandstone.config.ts')
  const configUrl = pathToFileURL(configPath).toString()
  const sandstoneConfig = (await import(configUrl)).default

  const namespace = cliOptions.namespace || sandstoneConfig.namespace
  const conflictStrategies: NonNullable<SandstoneContext['conflictStrategies']> = {}

  if (sandstoneConfig.onConflict) {
    for (const [resource, strategy] of Object.entries(sandstoneConfig.onConflict)) {
      conflictStrategies[resource] = strategy as NonNullable<SandstoneContext['conflictStrategies']>[string]
    }
  }

  const sandstoneUrl = pathToFileURL(path.join(folder, 'node_modules', 'sandstone', 'dist', 'exports', 'index.js'))
  /* @ts-ignore */
  const { createSandstonePack, resetSandstonePack } = (await import(sandstoneUrl)) as typeof sandstone

  const context: SandstoneContext = {
    workingDir: folder,
    namespace,
    packUid: sandstoneConfig.packUid,
    packOptions: sandstoneConfig.packs,
    conflictStrategies,
    loadVersion: sandstoneConfig.loadVersion,
  }

  const sandstonePack = createSandstonePack(context)

  return { sandstoneConfig, sandstonePack, resetSandstonePack }
}

interface BuildProjectResult {
  resourceCounts: ResourceCounts
  sandstoneConfig: sandstone.SandstoneConfig
  sandstonePack: sandstone.SandstonePack
  resetSandstonePack: () => void
}

async function _buildProject(
  cliOptions: BuildOptions,
  folder: string,
  silent = false,
  existingContext?: BuildContext,
  watching = false
): Promise<BuildProjectResult | undefined> {
  // Sync any linked libraries before the build. `_buildCommand` runs
  // this on every watch tick (including the ones triggered by a linked
  // library's `link_version` mtime change), so doing it once here keeps
  // both `sand build` and `sand watch` consistent.
  await syncLinkedLibraries(folder)

  // Read project package.json to get entrypoint
  const packageJsonPath = path.join(folder, 'package.json')
  const packageJson = JSON.parse(await fs.readText(packageJsonPath))

  const entrypoint = (() => {
    if (packageJson.module === undefined) {
      throw new Error(
        'No "module" field found in package.json. Please specify the entrypoint for your pack code.',
      )
    }
    return path.join(folder, packageJson.module)
  })()

  // Load or use existing context
  const { sandstoneConfig, sandstonePack, resetSandstonePack } = existingContext ??
    await loadBuildContext(cliOptions, folder)

  resetSandstonePack()

  const { scripts, resources } = sandstoneConfig
  const saveOptions = sandstoneConfig.saveOptions || {}

  const outputFolder = path.join(folder, '.sandstone', 'output')

  // The `local` object is the single source of truth for the build state.
  // Scripts receive it (per-phase narrowing) and can mutate destination
  // fields; the build reads from `local.X` after each script so reassignments
  // take effect. Functions exposed for the script's use are attached here too.
  // Typed as `AfterAllLocal` (the widest shape). Data fields (cache, post-save
  // state) are initialized with empty real values; later-phase data is
  // overwritten as the build progresses. At each script call site we narrow
  // to the per-phase type so scripts only see the fields available at that point.
  const local: sandstone.AfterAllLocal = {
    // Paths
    folder,
    outputFolder,

    // Config & pack
    sandstoneConfig,
    sandstonePack,
    saveOptions,
    resources,
    scripts,

    // CLI input
    cliOptions,

    // Entrypoint
    packageJson,
    entrypoint,

    // Resolved destinations (mutable — scripts can reroute)
    worldName: cliOptions.world || saveOptions.world,
    root: (cliOptions.root !== undefined ? cliOptions.root : saveOptions.root),
    clientPath: (!cliOptions.production
      ? (cliOptions.clientPath || saveOptions.clientPath)
      : undefined),
    serverPath: (!cliOptions.production
      ? (cliOptions.serverPath || saveOptions.serverPath)
      : undefined),
    packName: cliOptions.name ?? sandstoneConfig.name,

    // Functions available in every script
    hash,
    syncLinkedLibraries,
    getClientPath,
    getClientWorldPath,
    checkSymlinksAvailable,
    fs,

    // Function fields populated with their real imports. Their signatures
    // match `AfterAllLocal`/`BeforeSaveLocal` — they take `local` as the
    // first argument and read state from it.
    autoRegisterPackTypes,
    processExternalResources,
    processPackTypeOutput,
    createArchive,
    exportPack,
    getExportPath,
    runExportHandler,
    cleanupOldArchives,
    cleanupOldSymlinks,
    saveCache,

    // Cache & post-save state. Initialized with empty real values; the
    // cache is loaded from disk just before the beforeSave script and the
    // counters/exports are filled in just before the afterAll script.
    cacheFile: '',
    oldCache: { files: {} },
    newCache: { files: {} },
    changedPackTypes: new Set<string>(),
    newDirs: new Set<string>(),
    resourceCounts: { functions: 0, other: 0 },
    exports: false as string | false,
  }

  // Auto-detect client path if a world or root export is requested.
  if (local.worldName && !cliOptions.production) {
    local.clientPath ??= await getClientPath()
    if (local.clientPath) {
      await getClientWorldPath(local.worldName, local.clientPath)
    }
  } else if (local.root && !cliOptions.production) {
    local.clientPath ??= await getClientPath()
  }

  if (local.worldName && local.root) {
    throw new Error("Expected only 'world' or 'root'. Got both.")
  }

  const beforeAllResult = await local.scripts?.beforeAll?.(local as sandstone.BeforeAllLocal)

  if (beforeAllResult !== false) {
  // Import user code
  if (!silent) {
    log('Compiling source...')
  }

  try {
    if (await local.fs.fileExists(path.join(local.folder, local.entrypoint))) {
      const entrypointUrl = pathToFileURL(path.join(local.folder, local.entrypoint)).toString()
      await import(entrypointUrl)
      void watching
    }
  } catch (e: any) {
    e.message = `While loading "${path.join(local.folder, local.entrypoint)}":\n${e.message || e}`
    throw e
  }

  // Add dependencies if specified
  if (cliOptions.dependencies) {
    for (const dependency of cliOptions.dependencies) {
      sandstonePack.core.depend(...dependency)
    }
  }

  // Setup cache
  local.cacheFile = path.join(local.folder, '.sandstone', 'cache.json')
  local.oldCache = await loadCache(local)
  local.newCache = { files: {}, archives: [], packTypeExportZips: {} } as SandstoneCache
  local.changedPackTypes = new Set<string>()
  local.newDirs = new Set<string>()

  // Check symlink availability
  local.newCache.canUseSymlinks = await local.checkSymlinksAvailable(local)

  // Enrich local with the beforeSave-specific functions
  local.autoRegisterPackTypes = autoRegisterPackTypes
  local.processExternalResources = processExternalResources
  }

  // Run beforeSave script. Pass `local` directly (same mutability story
  // as beforeAll); the per-phase type narrows what TypeScript exposes.
  // A `false` return skips the builder code that follows until the next
  // entrypoint — `afterAll`.
  const beforeSaveResult = await local.scripts?.beforeSave?.(local as sandstone.BeforeSaveLocal)

  if (beforeSaveResult !== false) {
  // Auto-register pack types if existing resources are present
  await local.autoRegisterPackTypes(local)

  // File exclusion setup
  const excludeOption = local.resources?.exclude
  const fileExclusions: FileExclusions = excludeOption
    ? {
        generated: ('generated' in excludeOption ? excludeOption.generated : excludeOption) as RegExp[] | undefined,
        existing: ('existing' in excludeOption ? excludeOption.existing : excludeOption) as RegExp[] | undefined,
      }
    : false

  const fileHandlers: FileHandler[] | false = (local.resources?.handle as FileHandler[]) || false

  // Save the pack
  const packTypes = await local.sandstonePack.save({
    dry: cliOptions.dry ?? false,
    verbose: cliOptions.verbose ?? false,

    fileHandler: local.saveOptions.customFileHandler ??
      (async (relativePath: string, content: any) => {
        let pathPass = true
        if (fileExclusions && fileExclusions.generated) {
          for (const exclude of fileExclusions.generated) {
            if (!Array.isArray(exclude)) {
              pathPass = !exclude.test(relativePath)
            }
          }
        }

        if (fileHandlers) {
          for (const handler of fileHandlers) {
            if (handler.path.test(relativePath)) {
              content = await handler.callback(content)
            }
          }
        }

        if (pathPass) {
          const hashValue = local.hash(content + relativePath)
          local.newCache.files[relativePath] = hashValue

          for (let dir = path.dirname(relativePath); dir && dir !== '.'; dir = path.dirname(dir)) {
            local.newDirs.add(dir)
          }

          if (local.oldCache.files[relativePath] === hashValue) {
            return
          }

          const packTypeDir = relativePath.split(/[/\\]/)[0]
          local.changedPackTypes.add(packTypeDir)

          const realPath = path.join(local.outputFolder, relativePath)
          await local.fs.ensureDir(path.dirname(realPath))
          await local.fs.writeBytes(realPath, content instanceof ArrayBuffer ? Buffer.from(content) : content)
          return
        }
      }),
  })

  // Process and export packs
  const packTypesArray = [...packTypes]

  if (!cliOptions.production) {
    // Auto-detect client path if needed for client-side packs
    const hasClientPacks = packTypesArray.some(([, pt]) => pt.networkSides === 'client')
    if (hasClientPacks && !local.clientPath && (local.root || local.worldName)) {
      local.clientPath = await local.getClientPath()
    }

    const clientOnlyExport = !local.worldName && !local.root

    for (const [, packType] of packTypesArray) {
      const outputPath = path.join(local.outputFolder, packType.type)

      // Process pack type output (post-processing generated files)
      await local.processPackTypeOutput(local, packType, outputPath)
      await local.processExternalResources(local, packType.type, fileExclusions, fileHandlers)

      // Determine export destinations
      const shouldExportToClient = local.clientPath && !(clientOnlyExport && packType.networkSides !== 'client')
      const shouldExportToServer = local.serverPath && packType.networkSides === 'server'

      const clientDest = shouldExportToClient
        ? local.getExportPath(local, packType, 'client')
        : undefined
      const serverDest = shouldExportToServer
        ? local.getExportPath(local, packType, 'server')
        : undefined

      // For per-child symlinking (Smithed dep zips placed individually into
      // an existing destination directory), record the active child names
      // per destination path so `preserveSymlink` and `createSymlink` can
      // look them up directly. Only populated when the destination is itself
      // an existing directory — otherwise this packType uses folder symlinking
      // and the per-child list would just be noise.
      const isDir = async (dest: string | undefined): Promise<boolean> => {
        if (!dest) return false
        if (!(await local.fs.pathExists(dest))) return false
        return (await Bun.file(dest).stat().catch(() => null))?.isDirectory() ?? false
      }
      const [clientIsDir, serverIsDir] = await Promise.all([isDir(clientDest), isDir(serverDest)])
      if (clientIsDir || serverIsDir) {
        const packTypePrefix = packType.type + path.sep
        const entries = Object.keys(local.newCache.files)
          .filter((k) => k.startsWith(packTypePrefix))
          .map((k) => k.slice(packTypePrefix.length))
        if (entries.length > 0) {
          local.newCache.perChildEntries ??= {}
          if (clientIsDir) local.newCache.perChildEntries[clientDest!] = entries
          if (serverIsDir) local.newCache.perChildEntries[serverDest!] = entries
        }
      }

      // Preserve existing symlinks (even if no files changed)
      await preserveSymlink(clientDest, local.oldCache, local.newCache)
      await preserveSymlink(serverDest, local.oldCache, local.newCache)

      // Skip actual export if nothing changed
      if (!local.changedPackTypes.has(packType.type)) continue

      // Archive if configured. `exportZips` overrides the PackType's
      // `archiveOutput` default: `true` forces zip, `false` forces folder,
      // `undefined` falls back to the PackType default. The resolved value
      // is recorded in the cache so `sand clean` can read it back without
      // re-deriving it from the pack type's default.
      const shouldArchive = local.saveOptions.exportZips ?? packType.archiveOutput
      local.newCache.packTypeExportZips![packType.type] = shouldArchive

      let archivedOutput = false
      if (shouldArchive) {
        archivedOutput = await local.createArchive(local, packType)
      }

      // Export to destinations
      if (clientDest) {
        await local.exportPack(local, clientDest, packType, archivedOutput)
        await local.runExportHandler(local, packType, 'client', clientDest)
      }
      if (serverDest) {
        await local.exportPack(local, serverDest, packType, archivedOutput)
        await local.runExportHandler(local, packType, 'server', serverDest)
      }
    }
  } else {
    // Production mode: just process, no exports
    for (const [, packType] of packTypesArray) {
      const outputPath = path.join(local.outputFolder, packType.type)
      await local.processPackTypeOutput(local, packType, outputPath)
      await local.processExternalResources(local, packType.type, fileExclusions, fileHandlers)
    }
  }

  // Clean up old files and directories
  if (cliOptions.dry !== true) {
    const deletedDirs = new Set<string>()

    for (const file of Object.keys(local.oldCache.files)) {
      if (!(file in local.newCache.files)) {
        const fileDir = path.dirname(file)
        if (deletedDirs.has(fileDir)) continue
        let skipFile = false
        for (const deletedDir of deletedDirs) {
          if (fileDir.startsWith(deletedDir + path.sep)) {
            skipFile = true
            break
          }
        }
        if (skipFile) continue

        try {
          await local.fs.remove(path.join(local.outputFolder, file))
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e
          log(chalk.yellow('Warning:'), `Cached file not found during cleanup: ${file}`)
        }

        let dir: string | undefined = undefined
        for (const segment of split(new RegExp(RegExp.escape(path.sep)), fileDir)) {
          dir = dir === undefined ? segment : path.join(dir, segment)

          if (!local.newDirs.has(dir)) {
            await local.fs.remove(path.join(local.outputFolder, dir), { recursive: true, force: true })
            deletedDirs.add(dir)
            break
          }
        }
      }
    }

    await local.cleanupOldArchives(local)
    await local.cleanupOldSymlinks(local)

    await local.saveCache(local)
  }
  // Count resources
  local.resourceCounts = countResources(local.sandstonePack)
  local.exports = [local.clientPath && 'client', local.serverPath && 'server'].filter(Boolean).join(' & ') || false

  }  // end if (!skipUntilAfterAll)

  // Run afterAll script. `local` is the full AfterAllLocal shape; no
  // narrowing needed. A `false` return skips the final log message.
  const afterAllResult = await local.scripts?.afterAll?.(local as sandstone.AfterAllLocal)

  if (afterAllResult !== false && !silent) {
    const countMsg = `${local.resourceCounts.functions} functions, ${local.resourceCounts.other} other resources`
    log(`Pack(s) compiled! (${countMsg})${local.exports ? ` Exported to ${local.exports}.` : ''}`)
  }

  return { resourceCounts: local.resourceCounts, sandstoneConfig, sandstonePack, resetSandstonePack }
}

export async function _buildCommand(
  opts: BuildOptions,
  _folder?: string,
  existingContext?: BuildContext,
  watching = false
): Promise<BuildResult> {
  const folder = _folder ?? opts.path

  try {
    const result = await _buildProject(opts, folder, true, existingContext, watching)
    return {
      success: true,
      resourceCounts: result?.resourceCounts ?? { functions: 0, other: 0 },
      timestamp: Date.now(),
      sandstoneConfig: result?.sandstoneConfig,
      sandstonePack: result?.sandstonePack,
      resetSandstonePack: result?.resetSandstonePack,
    }
  } catch (err: any) {
    const errorMessage = err.message || String(err)
    const stack = (err.stack as string) || ''
    const cleanedStack = stack
      .replace(/\?hot-hook=\d+/g, '')
      .replace(/file:\/\/\//g, '')
      .replace(/file:\/\//g, '')
    // Stack includes message at top - extract only the trace lines to avoid duplication
    const stackLines = cleanedStack.split('\n')
    const traceStart = stackLines.findIndex(line => line.trimStart().startsWith('at '))
    const stackTrace = traceStart >= 0 ? stackLines.slice(traceStart).join('\n') : ''

    // Resolve source maps for better error locations
    const resolvedStackTrace = await resolveStackTrace(stackTrace)
    const formattedError = resolvedStackTrace ? `${errorMessage}\n${resolvedStackTrace}` : errorMessage
    return {
      success: false,
      error: formattedError,
      resourceCounts: { functions: 0, other: 0 },
      timestamp: Date.now(),
    }
  }
}

export async function buildCommand(opts: BuildOptions, _?: string): Promise<void>
export async function buildCommand(opts: BuildOptions, _folder: string | undefined, silent: true): Promise<BuildResult>
export async function buildCommand(opts: BuildOptions, _folder?: string, silent = false): Promise<BuildResult | void> {
  const folder = (typeof _folder === 'string') ? _folder : opts.path

  initLoggerNoFile()
  setSilent(silent)

  // `--debug`: mirror console output (everything logged via console.log /
  // console.info / console.warn / console.error / console.debug) to
  // `.sandstone/build-debug.log` IN ADDITION to stdout — same shape as
  // the watcher's `.sandstone/watch.log`. Restored in `finally`.
  let closeDebugLog: (() => Promise<void>) | undefined
  let restoreConsole: (() => void) | undefined
  if (opts.debug) {
    closeDebugLog = initBuildLogger(folder)
    restoreConsole = captureConsoleToFile()
  }

  // MC header + update checks run in parallel — neither blocks the build.
  // MC header is short (single readFile) — await it up front so the line
  // prints at the START of build output rather than after.
  const headerPromise = getMCHeaderAsync(folder)
  const checkPromise = runAllUpdateChecks(folder)
  const mcHeader = await headerPromise
  if (mcHeader) log(mcHeader)

  try {
    const result = await _buildProject(opts, folder, silent)
    const agg = await checkPromise
    const lines = aggregateToLines(agg)
    if (lines.length > 0) {
      log(chalk.yellow('⚠ Updates available — run:'))
      for (const line of lines) log(`  ${chalk.green('$')} ${line}`)
    }
    if (silent) {
      return {
        success: true,
        resourceCounts: result?.resourceCounts ?? { functions: 0, other: 0 },
        timestamp: Date.now(),
        sandstoneConfig: result?.sandstoneConfig,
        sandstonePack: result?.sandstonePack,
        resetSandstonePack: result?.resetSandstonePack,
      }
    }
  } catch (err: any) {
    const errorMessage = err.message || String(err)
    const stack = (err.stack as string) || ''
    const cleanedStack = stack
      .replace(/\?hot-hook=\d+/g, '')
      .replace(/file:\/\/\//g, '')
      .replace(/file:\/\//g, '')
    const stackLines = cleanedStack.split('\n')
    const traceStart = stackLines.findIndex(line => line.trimStart().startsWith('at '))
    const stackTrace = traceStart >= 0 ? stackLines.slice(traceStart).join('\n') : ''

    const resolvedStackTrace = await resolveStackTrace(stackTrace)
    const formattedError = resolvedStackTrace ? `${errorMessage}\n${resolvedStackTrace}` : errorMessage
    // Update notifications always print, even when silent (programmatic
    // callers should still see them).
    const agg = await checkPromise
    const lines = aggregateToLines(agg)
    if (lines.length > 0) {
      log(chalk.yellow('⚠ Updates available — run:'))
      for (const line of lines) log(`  ${chalk.green('$')} ${line}`)
    }
    if (!silent) {
      log(chalk.bgRed.white('BuildError') + chalk.gray(':'), formattedError)
      process.exit(1)
    }
    return {
      success: false,
      error: formattedError,
      resourceCounts: { functions: 0, other: 0 },
      timestamp: Date.now(),
    }
  } finally {
    restoreConsole?.()
    await closeDebugLog?.()
  }
}

/**
 * Override console.log/info/warn/error/debug to route through the CLI's
 * logger (which mirrors output to `.sandstone/build-debug.log` when
 * `--debug` is active). Mirrors the watcher's `enableConsoleCapture`
 * pattern in `commands/watch.ts` — no attempts to also touch
 * `process.stdout.write` / `process.stderr.write` (Bun has separate
 * native code paths for those that JS can't intercept, so it's not worth
 * the maintenance burden trying).
 *
 * Returns a restore function that puts the originals back.
 */
function captureConsoleToFile(): () => void {
  const originalLog = console.log.bind(console)
  const originalInfo = console.info.bind(console)
  const originalWarn = console.warn.bind(console)
  const originalError = console.error.bind(console)
  const originalDebug = console.debug.bind(console)

  ;(console as any).log = (...a: unknown[]) => log(...a)
  ;(console as any).info = (...a: unknown[]) => logInfo(...a)
  ;(console as any).warn = (...a: unknown[]) => logWarn(...a)
  ;(console as any).error = (...a: unknown[]) => logError(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' '))
  ;(console as any).debug = (...a: unknown[]) => logDebug(...a)

  return () => {
    ;(console as any).log = originalLog
    ;(console as any).info = originalInfo
    ;(console as any).warn = originalWarn
    ;(console as any).error = originalError
    ;(console as any).debug = originalDebug
  }
}
