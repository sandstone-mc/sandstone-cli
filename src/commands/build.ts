import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import fs from 'fs-extra'
import chalk from 'chalk'
import AdmZip from 'adm-zip'

import type { BuildResult, ResourceCounts } from '../ui/types.js'
import { log, logInfo, logWarn, logError as logErrorFn, logDebug, logTrace, initLoggerNoFile, setSilent } from '../ui/logger.js'
import { canUseSymlinks } from '../utils.js'
import { split } from 'obliterator'

import type * as sandstone from 'sandstone'

type SandstoneContext = ReturnType<typeof sandstone['getSandstoneContext']>

declare global {
  interface RegExpConstructor {
    escape(str: string): string;
  }
}

// Console capture for watch mode - wraps console to redirect output to our log file
const originalConsole = globalThis.console
let consoleWrapped = false

export function enableConsoleCapture() {
  if (consoleWrapped) return
  consoleWrapped = true

  // Wrap console methods to redirect to our logger with appropriate levels
  ;(globalThis.console as any).log = (...args: any[]) => log(...args)
  ;(globalThis.console as any).info = (...args: any[]) => logInfo(...args)
  ;(globalThis.console as any).warn = (...args: any[]) => logWarn(...args)
  ;(globalThis.console as any).error = (...args: any[]) => logErrorFn(args.join(' '))
  ;(globalThis.console as any).debug = (...args: any[]) => logDebug(...args)

  // Special handling for trace - capture stack at call site
  ;(globalThis.console as any).trace = (...args: any[]) => {
    const traceObj = { stack: '' }
    Error.captureStackTrace(traceObj, globalThis.console.trace)
    const cleanedStack = traceObj.stack
      .replace(/^Error\n/, '') // Remove "Error" header line
      .replace(/\?hot-hook=\d+/g, '')
      .replace(/file:\/\/\/?/g, '')
    logTrace(...args, '\n' + cleanedStack)
  }
}

export function disableConsoleCapture() {
  if (!consoleWrapped) return
  consoleWrapped = false

  // Restore original methods
  const methodsToRestore = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
  for (const method of methodsToRestore) {
    ;(globalThis.console as any)[method] = originalConsole[method].bind(originalConsole)
  }
}

export type BuildOptions = {
  // Flags
  dry?: boolean
  verbose?: boolean
  root?: boolean
  fullTrace?: boolean
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

type SandstoneCache = {
  files: Record<string, string>
  archives?: string[]
  canUseSymlinks?: boolean
  symlinks?: string[]
}

export interface BuildContext {
  sandstoneConfig: sandstone.SandstoneConfig
  sandstonePack: sandstone.SandstonePack
  resetSandstonePack: () => void
}

function hash(stringToHash: string): string {
  return crypto.createHash('md5').update(stringToHash).digest('hex')
}

let cache: SandstoneCache
let symlinksAvailable: boolean | undefined

async function getClientPath() {
  function getMCPath(): string {
    switch (os.platform()) {
      case 'win32':
        return path.join(os.homedir(), 'AppData/Roaming/.minecraft')
      case 'darwin':
        return path.join(os.homedir(), 'Library/Application Support/minecraft')
      case 'linux':
      default:
        return path.join(os.homedir(), '.minecraft')
    }
  }

  const mcPath = getMCPath()

  try {
    await fs.stat(mcPath)
  } catch {
    log('Unable to locate the .minecraft folder. Will not be able to export to client.')
    return undefined
  }

  return mcPath
}

async function getClientWorldPath(worldName: string, minecraftPath?: string) {
  const mcPath = minecraftPath ?? (await getClientPath())!
  const savesPath = path.join(mcPath, 'saves')
  const worldPath = path.join(savesPath, worldName)

  if (!fs.existsSync(worldPath)) {
    const existingWorlds = (await fs.readdir(savesPath, { withFileTypes: true }))
      .filter((f) => f.isDirectory())
      .map((f) => f.name)

    throw new Error(
      `Unable to locate the "${worldPath}" folder. World ${worldName} does not exist. List of existing worlds: ${JSON.stringify(existingWorlds, null, 2)}`,
    )
  }

  return worldPath
}

// Boilerplate resources to exclude from counts
const BOILERPLATE_NAMESPACES = new Set(['load', '__sandstone__'])
const BOILERPLATE_FUNCTIONS = new Set(['__init__'])
const BOILERPLATE_TAG = { namespace: 'minecraft', name: 'load' }

function isBoilerplateResource(resource: { path?: string[]; namespace?: string }): boolean {
  const ns = resource.namespace || ''
  const pathParts = resource.path || []
  const name = pathParts[pathParts.length - 1] || ''

  // Exclude load namespace and __sandstone__ namespace
  if (BOILERPLATE_NAMESPACES.has(ns)) return true

  // Exclude __init__ functions
  if (BOILERPLATE_FUNCTIONS.has(name)) return true

  if (ns === BOILERPLATE_TAG.namespace && name === BOILERPLATE_TAG.name) return true

  return false
}

function countResources(sandstonePack: { core: { resourceNodes: Iterable<{ resource: unknown }> } }): ResourceCounts {
  let functions = 0
  let other = 0

  for (const node of sandstonePack.core.resourceNodes) {
    const resource = node.resource as { constructor?: { name?: string }; path?: string[]; namespace?: string }

    // Skip boilerplate resources
    if (isBoilerplateResource(resource)) continue

    // Check if it's a function (MCFunctionClass)
    if (resource.constructor?.name === '_RawMCFunctionClass') {
      functions++
    } else {
      other++
    }
  }

  return { functions, other }
}

async function handleSymlink(folder: string, packName: string, cache: SandstoneCache, minecraftPath: string, targetPath: string, linkPath: string) {
  const allowPath = `[glob]${path.resolve(folder)}${path.sep}**${path.sep}*`

  const allowedList = path.join(minecraftPath, 'allowed_symlinks.txt')

  const comment = `# Sandstone Pack: ${packName}\n`
  try {
    const currentlyAllowed = await fs.readFile(allowedList)

    if (!currentlyAllowed.includes(allowPath)) {
      await fs.writeFile(allowedList, `${currentlyAllowed}\n#\n${comment}${allowPath}`)
    }
  } catch (e) {
    await fs.writeFile(allowedList, `${comment}${allowPath}`)
  }

  await fs.lstat(linkPath).then(() => {
    throw new Error(`Tried to add a symlink at "${linkPath}", encountered an existing file.`)
  }).catch(() => {})
  await fs.symlink(path.resolve(targetPath), linkPath)
  cache.symlinks ??= []
  cache.symlinks.push(linkPath)
}

export async function loadBuildContext(
  cliOptions: BuildOptions,
  folder: string,
): Promise<BuildContext> {
  // Load sandstone.config.ts
  const configPath = path.join(folder, 'sandstone.config.ts')
  const configUrl = pathToFileURL(configPath).toString()
  const sandstoneConfig = (await import(configUrl)).default

  // Build the context for sandstone
  const namespace = cliOptions.namespace || sandstoneConfig.namespace
  const conflictStrategies: NonNullable<SandstoneContext['conflictStrategies']> = {}

  if (sandstoneConfig.onConflict) {
    for (const [resource, strategy] of Object.entries(sandstoneConfig.onConflict)) {
      conflictStrategies[resource] = strategy as NonNullable<SandstoneContext['conflictStrategies']>[string]
    }
  }

  // Import sandstone from the project's node_modules, not the CLI's
  // This ensures we use the same module instance as the user code
  const sandstoneUrl = pathToFileURL(path.join(folder, 'node_modules', 'sandstone', 'dist', 'index.js'))
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

  // Create the pack with context
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

  // Get the entrypoint from the "module" field
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

  // Reset pack state before each build
  resetSandstonePack()

  const { scripts, resources } = sandstoneConfig
  const saveOptions = sandstoneConfig.saveOptions || {}

  const outputFolder = path.join(folder, '.sandstone', 'output')

  // Resolve options
  const worldName: string | undefined = cliOptions.world || saveOptions.world
  const root: boolean | undefined = cliOptions.root !== undefined ? cliOptions.root : saveOptions.root

  // Only use explicitly configured client path for now
  // We'll auto-detect after save() if there are client-side packs that need exporting
  let clientPath = !cliOptions.production
    ? cliOptions.clientPath || saveOptions.clientPath
    : undefined

  if (worldName && !cliOptions.production) {
    // Need client path for world export
    clientPath ??= await getClientPath()
    if (clientPath) {
      await getClientWorldPath(worldName, clientPath)
    }
  } else if (root && !cliOptions.production) {
    // Need client path for root export
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

  // Import user code (this executes their pack definitions)
  if (!silent) {
    log('Compiling source...')
  }

  try {
    if (await fs.pathExists(entrypointPath)) {
      const isBun = Object.hasOwn(globalThis, 'Bun')
      const entrypointUrl = pathToFileURL(entrypointPath).toString()

      if (watching && !isBun) {
        // Hot-hook for Node.js - only this should be hot reloaded
        // Bun doesn't support hot-hook, we clear require.cache instead in watch.ts
        await import(entrypointUrl, { with: { hot: 'true' } })
      } else {
        await import(entrypointUrl)
      }
    }
  } catch (e: any) {
    const errorMsg = `While loading "${entrypointPath}":\n${cliOptions.fullTrace ? e : (e.message || e)}`
    if (!silent) {
      console.error(chalk.bgRed.white('BuildError') + chalk.gray(':'), errorMsg)
    }
    log('BuildError:', errorMsg)
    throw e  // Re-throw for buildCommand to handle
  }

  // Add dependencies if specified
  if (cliOptions.dependencies) {
    for (const dependency of cliOptions.dependencies) {
      sandstonePack.core.depend(...dependency)
    }
  }

  // Setup cache
  const newCache: SandstoneCache = { files: {}, archives: [] }
  const cacheFile = path.join(folder, '.sandstone', 'cache.json')
  // Track which pack types have changed files
  const changedPackTypes = new Set<string>()
  // Track directories containing new files
  const newDirs = new Set<string>()

  if (cache === undefined) {
    try {
      const fileRead = await fs.readFile(cacheFile, 'utf8')
      if (fileRead) {
        const parsed = JSON.parse(fileRead)
        // Handle legacy cache format (plain Record<string, string>)
        if (parsed.files) {
          cache = parsed
        } else {
          cache = { files: parsed }
        }
      }
    } catch {
      cache = { files: {} }
    }
  }

  // Check symlink availability (use cached value if available)
  if (symlinksAvailable === undefined) {
    if (cache.canUseSymlinks !== undefined) {
      symlinksAvailable = cache.canUseSymlinks
    } else {
      symlinksAvailable = await canUseSymlinks()
    }
  }
  newCache.canUseSymlinks = symlinksAvailable

  // Run beforeSave script
  await scripts?.beforeSave?.()

  // File exclusion setup
  const excludeOption = resources?.exclude
  const fileExclusions = excludeOption
    ? {
        generated: ('generated' in excludeOption ? excludeOption.generated : excludeOption) as RegExp[] | undefined,
        existing: ('existing' in excludeOption ? excludeOption.existing : excludeOption) as RegExp[] | undefined,
      }
    : false

  const fileHandlers = (resources?.handle as {
    path: RegExp
    callback: (contents: string | Buffer | Promise<Buffer>) => Promise<Buffer>
  }[]) || false

  // Save the pack
  const packTypes = await sandstonePack.save({
    dry: cliOptions.dry ?? false,
    verbose: cliOptions.verbose ?? false,

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
          // Track parent directories
          for (let dir = path.dirname(relativePath); dir && dir !== '.'; dir = path.dirname(dir)) {
            newDirs.add(dir)
          }

          if (cache.files[relativePath] === hashValue) {
            return
          }

          // Track that this pack type has changed
          const packTypeDir = relativePath.split(/[/\\]/)[0]
          changedPackTypes.add(packTypeDir)

          const realPath = path.join(outputFolder, relativePath)
          await fs.ensureDir(path.dirname(realPath))
          return await fs.writeFile(realPath, content)
        }
      }),
  })

  // Handle resources folder
  async function handleResources(packType: string) {
    const working = path.join(folder, 'resources', packType)

    if (!(await fs.pathExists(working))) {
      return
    }

    const walk = async (dir: string): Promise<string[]> => {
      const files: string[] = []
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          files.push(...(await walk(fullPath)))
        } else {
          files.push(fullPath)
        }
      }
      return files
    }

    for (const file of await walk(working)) {
      const relativePath = path.join(packType, file.substring(working.length + 1))

      let pathPass = true
      if (fileExclusions && fileExclusions.existing) {
        for (const exclude of fileExclusions.existing) {
          pathPass = Array.isArray(exclude) ? !exclude[0].test(relativePath) : !exclude.test(relativePath)
        }
      }

      if (!pathPass) continue

      try {
        let content = await fs.readFile(file)

        if (fileHandlers) {
          for (const handler of fileHandlers) {
            if (handler.path.test(relativePath)) {
              content = (await handler.callback(content)) as Buffer<ArrayBuffer>
            }
          }
        }

        const hashValue = hash(content + relativePath)
        newCache.files[relativePath] = hashValue

        for (let dir = path.dirname(relativePath); dir && dir !== '.'; dir = path.dirname(dir)) {
          if (newDirs.has(dir)) {
            break
          } else {
            newDirs.add(dir)
          }
        }

        if (cache.files[relativePath] !== hashValue) {
          // Track that this pack type has changed
          changedPackTypes.add(packType)

          const realPath = path.join(outputFolder, relativePath)
          await fs.ensureDir(path.dirname(realPath))
          await fs.writeFile(realPath, content)
        }
      } catch {}
    }
  }

  // Archive output if needed
  async function archiveOutput(packType: any): Promise<boolean> {
    const input = path.join(outputFolder, packType.type)

    const files = await fs.readdir(input).catch(() => [])
    if (files.length === 0) return false

    const archiveName = `${packName}_${packType.type}.zip`
    newCache.archives!.push(archiveName)

    const archive = new AdmZip()
    await archive.addLocalFolderPromise(input, {})
    await fs.ensureDir(path.join(outputFolder, 'archives'))
    await archive.writeZipPromise(
      path.join(outputFolder, 'archives', archiveName),
      { overwrite: true },
    )

    return true
  }

  // Export to client/server
  if (!cliOptions.production) {
    // Check if there are any client-side packs that need exporting
    // If so and clientPath not set, try to find it now (after dependencies resolved)
    const packTypesArray = [...packTypes]
    const hasClientPacks = packTypesArray.some(([, pt]) => pt.networkSides === 'client')
    if (hasClientPacks && !clientPath && (root || worldName)) {
      clientPath = await getClientPath()
    }

    // When no world/root specified, only export client-side packs (resource packs + dependencies)
    const resourcePackOnlyExport = !worldName && !root

    for (const [, packType] of packTypesArray) {
      const outputPath = path.join(outputFolder, packType.type)
      await fs.ensureDir(outputPath)

      if (packType.handleOutput) {
        await packType.handleOutput(
          'output',
          async (relativePath: string, encoding: BufferEncoding = 'utf8') =>
            await fs.readFile(path.join(outputPath, relativePath), encoding),
          async (relativePath: string, contents: any) => {
            if (contents === undefined) {
              await fs.unlink(path.join(outputPath, relativePath))
            } else {
              await fs.writeFile(path.join(outputPath, relativePath), contents)
            }
          },
        )
      }

      await handleResources(packType.type)

      // Skip archive and export if no files in this pack type changed
      if (!changedPackTypes.has(packType.type)) {
        continue
      }

      let archivedOutput = false
      if (packType.archiveOutput && saveOptions.exportZips) {
        archivedOutput = await archiveOutput(packType)
      }

      // Handle client export
      // Skip non-client packs (datapacks) when in resource pack only mode (no world/root specified)
      if (clientPath && !(resourcePackOnlyExport && packType.networkSides !== 'client')) {
        let fullClientPath: string

        // Only export the resource pack to `$worldName$/resources.zip` if exportZips is on
        if (worldName && (packType.type !== 'resourcepack' || saveOptions.exportZips)) {
          fullClientPath = path.join(clientPath, packType.clientPath)
            .replace('$packName$', packName)
            .replace('$worldName$', worldName)
        } else {
          fullClientPath = path.join(clientPath, packType.rootPath).replace('$packName$', packName)
        }

        if (packType.archiveOutput && archivedOutput && saveOptions.exportZips) {
          const archivePath = path.join(outputFolder, 'archives', `${packName}_${packType.type}.zip`)
          await fs.copyFile(archivePath, `${fullClientPath}.zip`)
        } else if (symlinksAvailable) {
          if (cache.symlinks === undefined || !cache.symlinks.includes(fullClientPath)) {
            handleSymlink(
              folder,
              packName,
              newCache,
              clientPath,
              outputPath,
              fullClientPath,
            )
          }
        } else {
          await fs.remove(fullClientPath)
          await fs.copy(outputPath, fullClientPath)
        }
      }

      // Handle server export (skip client-only packs like resource packs)
      if (serverPath && packType.networkSides === 'server') {
        const fullServerPath = path.join(serverPath, packType.serverPath).replace('$packName$', packName)

        if (packType.archiveOutput && archivedOutput && saveOptions.exportZips) {
          const archivePath = path.join(outputFolder, 'archives', `${packName}_${packType.type}.zip`)
          await fs.copyFile(archivePath, `${fullServerPath}.zip`)
        } else if (symlinksAvailable) {
          if (cache.symlinks === undefined || !cache.symlinks.includes(fullServerPath)) {
            handleSymlink(
              folder,
              packName,
              newCache,
              serverPath,
              outputPath,
              fullServerPath,
            )
          }
        } else {
          await fs.remove(fullServerPath)
          await fs.copy(outputPath, fullServerPath)
        }
      }
    }
  } else {
    // Production mode
    for await (const [, packType] of packTypes) {
      const outputPath = path.join(outputFolder, packType.type)

      if (packType.handleOutput) {
        await packType.handleOutput(
          'output',
          async (relativePath: string, encoding: BufferEncoding = 'utf8') =>
            await fs.readFile(path.join(outputPath, relativePath), encoding),
          async (relativePath: string, contents: any) => {
            if (contents === undefined) {
              await fs.unlink(path.join(outputPath, relativePath))
            } else {
              await fs.writeFile(path.join(outputPath, relativePath), contents)
            }
          },
        )
      }

      await handleResources(packType.type)
    }
  }

  // Clean up old files, directories, and symlinks not in new cache
  if (cliOptions.dry !== true) {
    for (const file of Object.keys(cache.files)) {
      if (!(file in newCache.files)) {
        await fs.rm(path.join(outputFolder, file))

        let dir: string | undefined = undefined
        for (const segment of split(new RegExp(RegExp.escape(path.sep)), path.dirname(file))) {
          dir = dir === undefined ? segment : path.join(dir, segment)

          if (!newDirs.has(dir)) {
            await fs.rm(path.join(outputFolder, dir), { force: true, recursive: true })
            break
          }
        }
      }
    }

    // Clean up old archives
    if (cache.archives) {
      const archivesDir = path.join(outputFolder, 'archives')
      if (newCache.archives === undefined || newCache.archives.length === 0) {
        await fs.rm(archivesDir, { force: true, recursive: true })
      }
      for (const archive of cache.archives) {
        if (!newCache.archives!.includes(archive)) {
          await fs.rm(path.join(archivesDir, archive))
        }
      }
    }

    if (cache.symlinks) {
      const newSymlinks = new Set(newCache.symlinks)

      for (const symlink of cache.symlinks) {
        if (!newSymlinks.has(symlink)) {
          await fs.rm(symlink)
        }
      }
    }

    // Update cache
    cache = newCache
    await fs.ensureDir(path.dirname(cacheFile))
    await fs.writeFile(cacheFile, JSON.stringify(cache))
  }

  // Run afterAll script
  await scripts?.afterAll?.()

  // Count resources (excluding boilerplate)
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
    // Always include stack trace for better debugging - format paths for terminal clickability
    const stack = err.stack || ''
    // Clean up stack trace: remove ?hot-hook query params and convert file:// URLs to paths
    const cleanedStack = stack
      .replace(/\?hot-hook=\d+/g, '') // Remove hot-hook cache busting params
      .replace(/file:\/\/\//g, '') // Convert file:/// URLs to paths (Windows)
      .replace(/file:\/\//g, '') // Convert file:// URLs to paths (Unix)
    const formattedError = cleanedStack ? `${errorMessage}\n${cleanedStack}` : errorMessage
    log('Build failed:', errorMessage)
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
  // Commander passes Command object as second arg, so check for string explicitly
  const folder = (typeof _folder === 'string') ? _folder : opts.path

  // Initialize logger without file for build mode
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
    if (!silent) {
      console.error(chalk.red('Build failed:'), errorMessage)
      if (opts.fullTrace) {
        console.error(err)
      }
    }
    log('Build failed:', errorMessage)
    if (silent) {
      return {
        success: false,
        error: opts.fullTrace ? String(err) : errorMessage,
        resourceCounts: { functions: 0, other: 0 },
        timestamp: Date.now(),
      }
    }
  }
}
