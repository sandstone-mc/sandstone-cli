import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'fs-extra'
import chalk from 'chalk'
import { split } from 'obliterator'

import type { BuildResult, ResourceCounts } from '../../ui/types.js'
import { log, initLoggerNoFile, setSilent } from '../../ui/logger.js'
import { hash } from '../../utils.js'

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

async function loadCache(cacheFile: string): Promise<SandstoneCache> {
  if (Object.keys(cache.files).length > 0) {
    return cache
  }

  try {
    const fileRead = await fs.readFile(cacheFile, 'utf8')
    if (fileRead) {
      const parsed = JSON.parse(fileRead)
      cache = parsed.files ? parsed : { files: parsed }
    }
  } catch {
    cache = { files: {} }
  }

  return cache
}

async function saveCache(cacheFile: string, newCache: SandstoneCache) {
  cache = newCache
  await fs.ensureDir(path.dirname(cacheFile))
  await fs.writeFile(cacheFile, JSON.stringify(cache))
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
  packType: PackType,
  outputPath: string
) {
  await fs.ensureDir(outputPath)

  if (packType.handleOutput) {
    await packType.handleOutput(
      'output',
      (async (relativePath: string, encoding: BufferEncoding = 'utf8') =>
        await fs.readFile(path.join(outputPath, relativePath), encoding)) as unknown as handlerReadFile,
      async (relativePath: string, contents: any) => {
        if (contents === undefined) {
          await fs.unlink(path.join(outputPath, relativePath))
        } else {
          await fs.writeFile(
            path.join(outputPath, relativePath),
            contents
          )
        }
      },
    )
  }
}

export async function loadBuildContext(
  cliOptions: BuildOptions,
  folder: string,
): Promise<BuildContext> {
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
  // Read project package.json to get entrypoint
  const packageJsonPath = path.join(folder, 'package.json')
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))

  const entrypoint = packageJson.module
  if (!entrypoint) {
    throw new Error(
      'No "module" field found in package.json. Please specify the entrypoint for your pack code.',
    )
  }

  const entrypointPath = path.join(folder, entrypoint)

  // Load or use existing context
  const { sandstoneConfig, sandstonePack, resetSandstonePack } = existingContext ??
    await loadBuildContext(cliOptions, folder)

  resetSandstonePack()

  const { scripts, resources } = sandstoneConfig
  const saveOptions = sandstoneConfig.saveOptions || {}

  const outputFolder = path.join(folder, '.sandstone', 'output')

  // Resolve export options
  const worldName: string | undefined = cliOptions.world || saveOptions.world
  const root: boolean | undefined = cliOptions.root !== undefined ? cliOptions.root : saveOptions.root

  let clientPath = !cliOptions.production
    ? cliOptions.clientPath || saveOptions.clientPath
    : undefined

  if (worldName && !cliOptions.production) {
    clientPath ??= await getClientPath()
    if (clientPath) {
      await getClientWorldPath(worldName, clientPath)
    }
  } else if (root && !cliOptions.production) {
    clientPath ??= await getClientPath()
  }

  const serverPath = !cliOptions.production
    ? cliOptions.serverPath || saveOptions.serverPath
    : undefined
  const packName: string = cliOptions.name ?? sandstoneConfig.name

  if (worldName && root) {
    throw new Error("Expected only 'world' or 'root'. Got both.")
  }

  // Run beforeAll script
  await scripts?.beforeAll?.()

  // Import user code
  if (!silent) {
    log('Compiling source...')
  }

  try {
    if (await fs.pathExists(entrypointPath)) {
      const isBun = Object.hasOwn(globalThis, 'Bun')
      const entrypointUrl = pathToFileURL(entrypointPath).toString()

      if (watching && !isBun) {
        await import(entrypointUrl, { with: { hot: 'true' } })
      } else {
        await import(entrypointUrl)
      }
    }
  } catch (e: any) {
    // Enhance error with context, let callers handle logging
    e.message = `While loading "${entrypointPath}":\n${e.message || e}`
    throw e
  }

  // Add dependencies if specified
  if (cliOptions.dependencies) {
    for (const dependency of cliOptions.dependencies) {
      sandstonePack.core.depend(...dependency)
    }
  }

  // Setup cache
  const cacheFile = path.join(folder, '.sandstone', 'cache.json')
  const oldCache = await loadCache(cacheFile)
  const newCache: SandstoneCache = { files: {}, archives: [] }

  const changedPackTypes = new Set<string>()
  const newDirs = new Set<string>()

  // Check symlink availability
  newCache.canUseSymlinks = await checkSymlinksAvailable(oldCache.canUseSymlinks)

  // Run beforeSave script
  await scripts?.beforeSave?.()

  // Auto-register pack types if existing resources are present
  await autoRegisterPackTypes(folder, sandstonePack)

  // File exclusion setup
  const excludeOption = resources?.exclude
  const fileExclusions: FileExclusions = excludeOption
    ? {
        generated: ('generated' in excludeOption ? excludeOption.generated : excludeOption) as RegExp[] | undefined,
        existing: ('existing' in excludeOption ? excludeOption.existing : excludeOption) as RegExp[] | undefined,
      }
    : false

  const fileHandlers: FileHandler[] | false = (resources?.handle as FileHandler[]) || false

  // Save the pack
  const packTypes = await sandstonePack.save({
    dry: cliOptions.dry ?? false,
    verbose: cliOptions.verbose ?? false,

    // TODO: Implement `contentSummary` and remove this typecast
    fileHandler: (saveOptions.customFileHandler as ((relativePath: string, content: any) => Promise<void>) | undefined) ??
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
          const hashValue = hash(content + relativePath)
          newCache.files[relativePath] = hashValue

          for (let dir = path.dirname(relativePath); dir && dir !== '.'; dir = path.dirname(dir)) {
            newDirs.add(dir)
          }

          if (oldCache.files[relativePath] === hashValue) {
            return
          }

          const packTypeDir = relativePath.split(/[/\\]/)[0]
          changedPackTypes.add(packTypeDir)

          const realPath = path.join(outputFolder, relativePath)
          await fs.ensureDir(path.dirname(realPath))
          return await fs.writeFile(realPath, content)
        }
      }),
  })

  // Process and export packs
  const packTypesArray = [...packTypes]

  if (!cliOptions.production) {
    // Auto-detect client path if needed for client-side packs
    const hasClientPacks = packTypesArray.some(([, pt]) => pt.networkSides === 'client')
    if (hasClientPacks && !clientPath && (root || worldName)) {
      clientPath = await getClientPath()
    }

    const clientOnlyExport = !worldName && !root

    for (const [, packType] of packTypesArray) {
      const outputPath = path.join(outputFolder, packType.type)

      // Process pack type output (post-processing generated files)
      await processPackTypeOutput(packType, outputPath)
      await processExternalResources(packType.type, folder, outputFolder, oldCache, newCache, changedPackTypes, newDirs, fileExclusions, fileHandlers)

      // Determine export destinations
      const shouldExportToClient = clientPath && !(clientOnlyExport && packType.networkSides !== 'client')
      const shouldExportToServer = serverPath && packType.networkSides === 'server'

      const clientDest = shouldExportToClient
        ? getExportPath(packType, clientPath!, 'client', packName, worldName, saveOptions.exportZips)
        : undefined
      const serverDest = shouldExportToServer
        ? getExportPath(packType, serverPath!, 'server', packName, worldName, saveOptions.exportZips)
        : undefined

      // Preserve existing symlinks (even if no files changed)
      preserveSymlink(clientDest, oldCache, newCache)
      preserveSymlink(serverDest, oldCache, newCache)

      // Skip actual export if nothing changed
      if (!changedPackTypes.has(packType.type)) continue

      // Archive if configured
      let archivedOutput = false
      if (packType.archiveOutput && saveOptions.exportZips) {
        archivedOutput = await createArchive(outputFolder, packName, packType, newCache)
      }

      // Export to destinations
      if (clientDest) {
        await exportPack(clientDest, clientPath!, outputPath, outputFolder, folder, packName, packType, archivedOutput, saveOptions.exportZips, oldCache, newCache)
        await runExportHandler(packType, 'client', clientDest)
      }
      if (serverDest) {
        await exportPack(serverDest, serverPath!, outputPath, outputFolder, folder, packName, packType, archivedOutput, saveOptions.exportZips, oldCache, newCache)
        await runExportHandler(packType, 'server', serverDest)
      }
    }
  } else {
    // Production mode: just process, no exports
    for (const [, packType] of packTypesArray) {
      const outputPath = path.join(outputFolder, packType.type)
      await processPackTypeOutput(packType, outputPath)
      await processExternalResources(packType.type, folder, outputFolder, oldCache, newCache, changedPackTypes, newDirs, fileExclusions, fileHandlers)
    }
  }

  // Clean up old files and directories
  if (cliOptions.dry !== true) {
    const deletedDirs = new Set<string>()

    for (const file of Object.keys(oldCache.files)) {
      if (!(file in newCache.files)) {
        // Skip files whose parent directory was already deleted
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
          await fs.rm(path.join(outputFolder, file))
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e
          log(chalk.yellow('Warning:'), `Cached file not found during cleanup: ${file}`)
        }

        let dir: string | undefined = undefined
        for (const segment of split(new RegExp(RegExp.escape(path.sep)), fileDir)) {
          dir = dir === undefined ? segment : path.join(dir, segment)

          if (!newDirs.has(dir)) {
            await fs.rm(path.join(outputFolder, dir), { force: true, recursive: true })
            deletedDirs.add(dir)
            break
          }
        }
      }
    }

    await cleanupOldArchives(outputFolder, oldCache, newCache)
    await cleanupOldSymlinks(oldCache, newCache)

    await saveCache(cacheFile, newCache)
  }

  // Run afterAll script
  await scripts?.afterAll?.()

  // Count resources
  const resourceCounts = countResources(sandstonePack)

  const exports = [clientPath && 'client', serverPath && 'server'].filter(Boolean).join(' & ') || false
  const countMsg = `${resourceCounts.functions} functions, ${resourceCounts.other} other resources`
  if (!silent) {
    log(`Pack(s) compiled! (${countMsg})${exports ? ` Exported to ${exports}.` : ''}`)
  }

  return { resourceCounts, sandstoneConfig, sandstonePack, resetSandstonePack }
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
    const formattedError = stackTrace ? `${errorMessage}\n${stackTrace}` : errorMessage
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

  try {
    const result = await _buildProject(opts, folder, silent)
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
    // Stack includes message at top - extract only the trace lines to avoid duplication
    const stackLines = cleanedStack.split('\n')
    const traceStart = stackLines.findIndex(line => line.trimStart().startsWith('at '))
    const stackTrace = traceStart >= 0 ? stackLines.slice(traceStart).join('\n') : ''
    const formattedError = stackTrace ? `${errorMessage}\n${stackTrace}` : errorMessage
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
  }
}
