import path from 'path'
import { pathToFileURL } from 'url'
import chalk from 'chalk-template'
import { split } from 'obliterator'

import type { BuildResult, ResourceCounts } from '../../ui/types.js'
import { Logger, logger, type LoggerSink } from '../../utils/logger.js'
import { add, hash, printSplash } from '../../utils/index.js'
import * as fs from '../../utils/fs.js'
import { resolveStackTrace } from '../../utils/source-map.js'
import { syncLinkedLibraries } from '../link.js'
import { getMCVersionHeader, runAllUpdateChecks } from '../../utils/updateCheck.js'

let activeSink: LoggerSink = logger.sinks.console
const log = (...a: unknown[]) => activeSink.log(...a)

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
import type { PackType } from 'sandstone/pack'
import { loadSandstoneConfig } from '../../utils/sandstoneConfig.js'

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
  test?: boolean

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
  resetSandstonePack: (ctx?: sandstone.SandstoneContext) => void
  context: sandstone.SandstoneContext
}

export function resolveActiveSaveConfig(
  cliOptions: BuildOptions,
  configSaveOptions: sandstone.SandstoneConfig['saveOptions'],
): sandstone.SandstoneConfig['saveOptions'] {
  const saveOptions = configSaveOptions ?? {}
  return {
    world: cliOptions.world || saveOptions.world,
    ...add({ root: cliOptions.root ?? saveOptions.root }),
    clientPath: !cliOptions.production
      ? (cliOptions.clientPath || saveOptions.clientPath)
      : undefined,
    serverPath: !cliOptions.production
      ? (cliOptions.serverPath || saveOptions.serverPath)
      : undefined,
  } as never
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

function assembleSandstoneContext(
  cliOptions: BuildOptions,
  folder: string,
  sandstoneConfig: sandstone.SandstoneConfig,
): SandstoneContext {
  const conflictStrategies: NonNullable<SandstoneContext['conflictStrategies']> = {}
  if (sandstoneConfig.onConflict) {
    for (const [resource, strategy] of Object.entries(sandstoneConfig.onConflict)) {
      conflictStrategies[resource] = strategy as NonNullable<SandstoneContext['conflictStrategies']>[string]
    }
  }
  return {
    workingDir: folder,
    namespace: cliOptions.namespace || sandstoneConfig.namespace,
    packUid: sandstoneConfig.packUid,
    packOptions: sandstoneConfig.packs,
    conflictStrategies,
    loadVersion: (sandstoneConfig as { loadVersion?: number }).loadVersion,
    enableTests: cliOptions.test,
  }
}

export async function loadBuildContext(
  cliOptions: BuildOptions,
  _folder: string,
): Promise<BuildContext> {
  const folder = path.resolve(_folder)

  const sandstoneConfig = await loadSandstoneConfig(folder)
  if (!sandstoneConfig) {
    throw new Error(`Could not load "${path.join(folder, 'sandstone.config.ts')}"`)
  }

  const sandstoneUrl = pathToFileURL(path.join(folder, 'node_modules', 'sandstone', 'dist', 'exports', 'index.js'))
  /* @ts-ignore */
  const { createSandstonePack, resetSandstonePack } = (await import(sandstoneUrl)) as typeof sandstone

  const context = assembleSandstoneContext(cliOptions, folder, sandstoneConfig)
  const sandstonePack = createSandstonePack(context)

  return { sandstoneConfig, sandstonePack, resetSandstonePack, context }
}

interface BuildProjectResult {
  resourceCounts: ResourceCounts
  sandstoneConfig: sandstone.SandstoneConfig
  sandstonePack: sandstone.SandstonePack
  resetSandstonePack: () => void
  activeSaveConfig: sandstone.SandstoneConfig['saveOptions']
}

async function _buildProject(
  cliOptions: BuildOptions,
  folder: string,
  silent = false,
  existingContext?: BuildContext
): Promise<BuildProjectResult | undefined> {
  await syncLinkedLibraries(folder, activeSink)
  const syncLinkedLibrariesForLocal: (projectPath: string) => Promise<number> =
    (projectPath) => syncLinkedLibraries(projectPath, activeSink)

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

  const ctx: BuildContext = existingContext ?? await loadBuildContext(cliOptions, folder)

  ctx.resetSandstonePack(assembleSandstoneContext(cliOptions, folder, ctx.sandstoneConfig))

  const { sandstoneConfig, sandstonePack } = ctx

  const { scripts, resources } = sandstoneConfig
  let saveOptions = sandstoneConfig.saveOptions || {}

  if (!saveOptions.serverPath && !cliOptions.serverPath) {
    const mcServerPath = path.join(folder, '.sandstone', 'mc-server')
    if (await fs.pathExists(mcServerPath)) {
      saveOptions = { ...saveOptions, serverPath: mcServerPath }
    }
  }
  const activeSaveConfig = resolveActiveSaveConfig(cliOptions, saveOptions)

  const outputFolder = path.join(folder, '.sandstone', 'output')

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

    // Resolved destinations
    worldName: activeSaveConfig.world,
    root: activeSaveConfig.root,
    clientPath: activeSaveConfig.clientPath,
    serverPath: activeSaveConfig.serverPath,
    packName: cliOptions.name ?? sandstoneConfig.name,

    // Functions available in every script
    hash,
    syncLinkedLibraries: syncLinkedLibrariesForLocal,
    getClientPath: () => getClientPath(activeSink),
    getClientWorldPath: (worldName: string, minecraftPath?: string) => getClientWorldPath(worldName, minecraftPath, activeSink),
    checkSymlinksAvailable: (local: sandstone.BeforeSaveLocal) => checkSymlinksAvailable(local, activeSink),
    fs,

    // Function fields populated with their real imports. Their signatures
    // match `AfterAllLocal`/`BeforeSaveLocal`.
    autoRegisterPackTypes,
    processExternalResources,
    processPackTypeOutput,
    createArchive,
    exportPack: (local: sandstone.AfterAllLocal, destPath: string, packType: PackType, archivedOutput: boolean, target: 'client' | 'server') => exportPack(local, destPath, activeSink, packType, archivedOutput, target),
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
    local.clientPath ??= await local.getClientPath()
    if (local.clientPath) {
      await local.getClientWorldPath(local.worldName, local.clientPath)
    }
  } else if (local.root && !cliOptions.production) {
    local.clientPath ??= await local.getClientPath()
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
    }
  } catch (e: any) {
    e.message = `While loading "${path.join(local.folder, local.entrypoint)}":\n${e.message || e}`
    throw e
  }

  // Add dependencies if specified
  // NOTE: `sandstonePack.core.depend(...)` was removed when the
  // vanilla install pipeline was deleted. The `cliOptions.dependencies`
  // surface is intentionally left intact so existing JSON configs
  // don't fail to parse, but the values are ignored at runtime —
  // a follow-up will wire a replacement once the new dep story lands.

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

  if (cliOptions.test) {
    const testEntries: Array<{
      name: string
      description?: string
      optional?: boolean
      sourceFile?: string
      /** Line + column of `Test.create(...)` for fallback `build_trace`
       *  when a runtime failure can't be tied to a specific line. */
      sourceLine?: number
      sourceColumn?: number
    }> = []
    const throwables: Record<string, unknown> = {}
    const tests = local.sandstonePack.Test.tests
    tests.forEach((node) => {
      const resource = node.resource
      testEntries.push({
        name: resource.name,
        description: resource.description,
        optional: resource.directives?.optional,
        sourceFile: resource.sourceFile,
        sourceLine: resource.sourceLine,
        sourceColumn: resource.sourceColumn,
      })
      for (const [key, entry] of node.throwableStack) {
        throwables[key] = entry
      }
    })
    const testsJsonPath = path.join(local.outputFolder, '..', 'tests.json')
    await local.fs.ensureDir(path.dirname(testsJsonPath))
    const logTraces = Object.fromEntries(local.sandstonePack.Test.logTraces)
    await local.fs.writeJSON(testsJsonPath, { tests: testEntries, throwables, log_traces: logTraces }, { pretty: true })
  }

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

        if (packType.type === 'datapack_dependencies') {
          const packTypeOutputDir = path.join(local.outputFolder, packType.type)
          if (await local.fs.pathExists(packTypeOutputDir)) {
            const names = await local.fs.readDirNames(packTypeOutputDir)
            for (const name of names) {
              if (name.includes('/') || name.includes('\\')) continue
              if (entries.includes(name)) continue
              try {
                const s = await local.fs.fileStat(path.join(packTypeOutputDir, name))
                if (!s.isDirectory()) continue
              } catch {
                continue
              }
              entries.push(name)
            }
          }
        }

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
        await local.exportPack(local, clientDest, packType, archivedOutput, 'client')
        await local.runExportHandler(local, packType, 'client', clientDest)
      }
      if (serverDest) {
        await local.exportPack(local, serverDest, packType, archivedOutput, 'server')
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
          log(chalk`{yellow Warning}{gray :} Cached file not found during cleanup: ${file}`)
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

  const afterAllResult = await local.scripts?.afterAll?.(local as sandstone.AfterAllLocal)

  if (afterAllResult !== false && !silent) {
    const countMsg = `${local.resourceCounts.functions} functions, ${local.resourceCounts.other} other resources`
    log(`Pack(s) compiled! (${countMsg})${local.exports ? ` Exported to ${local.exports}.` : ''}`)
  }

  return {
    resourceCounts: local.resourceCounts,
    sandstoneConfig,
    sandstonePack,
    resetSandstonePack: ctx.resetSandstonePack,
    activeSaveConfig: {
      world: local.worldName,
      ...add({ root: local.root }),
      clientPath: local.clientPath,
      serverPath: local.serverPath,
    } as never,
  }
}

export async function _buildCommand(
  opts: BuildOptions,
  _folder?: string,
  existingContext?: BuildContext
): Promise<BuildResult> {
  const folder = _folder ?? opts.path

  try {
    const result = await _buildProject(opts, folder, true, existingContext)
    return {
      success: true,
      resourceCounts: result?.resourceCounts ?? { functions: 0, other: 0 },
      timestamp: Date.now(),
      sandstoneConfig: result?.sandstoneConfig,
      sandstonePack: result?.sandstonePack,
      resetSandstonePack: result?.resetSandstonePack,
      activeSaveConfig: result?.activeSaveConfig,
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

export async function buildCommand(opts: BuildOptions) {
  const folder = opts.path

  activeSink = logger.sinks.console
  Logger.setupConsoleSink()
  printSplash()

  let closeDebugLog: (() => Promise<void>) | undefined
  if (opts.debug) {
    closeDebugLog = logger.registerSink('build', path.join(folder, '.sandstone', 'build-debug.log'), 'Build debug')
    activeSink = logger.sinks.build
  }

  const mcVersionHeader = getMCVersionHeader(folder)
  const mcHeader = await mcVersionHeader
  if (mcHeader) log(mcHeader)

  let errored = false

  const updates = runAllUpdateChecks(folder)
  try {
    await _buildProject(opts, folder)
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
    log(chalk`{bgRed {white BuildError}{gray :}`, formattedError)
    errored = true
  }
  try {
    const updateCommands = await updates
    if (updateCommands.length > 0) {
      log(chalk`{yellow ⚠ Updates available — run:`)
      for (const command of updateCommands) log(chalk`  {green $} ${command}`)
    }
  } catch {}
  await closeDebugLog?.()
  if (errored) process.exit(1)
}
