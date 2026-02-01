import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import fs from 'fs-extra'
import chalk from 'chalk'
import AdmZip from 'adm-zip'

import type { ProjectFolders } from '../utils.js'
import { getProjectFolders } from '../utils.js'

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
  configPath: string
  name?: string
  namespace?: string
  world?: string
  clientPath?: string
  serverPath?: string

  enableSymlinks?: boolean

  dependencies?: [string, string][]
}

type SandstoneCache = Record<string, string>

function hash(stringToHash: string): string {
  return crypto.createHash('md5').update(stringToHash).digest('hex')
}

let cache: SandstoneCache

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
    console.warn('Unable to locate the .minecraft folder. Will not be able to export to client.')
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

async function _buildProject(
  cliOptions: BuildOptions,
  { absProjectFolder, rootFolder, sandstoneConfigFolder }: ProjectFolders,
) {
  // Read project package.json to get entrypoint
  const packageJsonPath = path.join(rootFolder, 'package.json')
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))

  // Get the entrypoint from the "module" field
  const entrypoint = packageJson.module
  if (!entrypoint) {
    throw new Error(
      'No "module" field found in package.json. Please specify the entrypoint for your pack code.',
    )
  }

  const entrypointPath = path.join(rootFolder, entrypoint)

  // Load sandstone.config.ts
  const configPath = path.join(sandstoneConfigFolder, 'sandstone.config.ts')
  const sandstoneConfig = (await import(pathToFileURL(configPath).toString())).default

  const { scripts } = sandstoneConfig
  const saveOptions = sandstoneConfig.saveOptions || {}

  const outputFolder = path.join(rootFolder, '.sandstone', 'output')

  // Resolve options
  const clientPath = !cliOptions.production
    ? cliOptions.clientPath || saveOptions.clientPath || (await getClientPath())
    : undefined

  let worldName: string | undefined = cliOptions.world || saveOptions.world
  if (worldName && !cliOptions.production) {
    await getClientWorldPath(worldName, clientPath)
  }

  const root = cliOptions.root !== undefined ? cliOptions.root : saveOptions.root
  const packName: string = cliOptions.name ?? sandstoneConfig.name

  if (worldName && root) {
    throw new Error("Expected only 'world' or 'root'. Got both.")
  }

  // Build the context for sandstone
  const namespace = cliOptions.namespace || sandstoneConfig.namespace
  const conflictStrategies: NonNullable<SandstoneContext['conflictStrategies']> = {}

  if (sandstoneConfig.onConflict) {
    for (const [resource, strategy] of Object.entries(sandstoneConfig.onConflict)) {
      conflictStrategies[resource] = strategy as NonNullable<SandstoneContext['conflictStrategies']>[string]
    }
  }

  // Import sandstone and set up context
  /* @ts-ignore */
  const { createSandstonePack, resetSandstonePack } = await import('sandstone')
  /* @ts-ignore */
  type SandstoneContext = import('sandstone').SandstoneContext

  // Reset any existing pack state
  resetSandstonePack()

  const context: SandstoneContext = {
    workingDir: absProjectFolder,
    namespace,
    packUid: sandstoneConfig.packUid,
    packOptions: sandstoneConfig.packs,
    conflictStrategies,
    loadVersion: sandstoneConfig.loadVersion,
  }

  // Create the pack with context
  const sandstonePack = createSandstonePack(context)

  // Run beforeAll script
  await scripts?.beforeAll?.()

  // Import user code (this executes their pack definitions)
  console.log('Compiling source...\n')

  try {
    if (await fs.pathExists(entrypointPath)) {
      await import(pathToFileURL(entrypointPath).toString())
    }
  } catch (e: any) {
    console.error(chalk.bgRed.white('BuildError') + chalk.gray(':'), `While loading "${entrypointPath}":\n`)
    if (cliOptions.fullTrace) {
      console.error(e)
    } else {
      console.error(e.message || e)
    }
    return
  }

  // Add dependencies if specified
  if (cliOptions.dependencies) {
    for (const dependency of cliOptions.dependencies) {
      sandstonePack.core.depend(...dependency)
    }
  }

  // Setup cache
  const newCache: SandstoneCache = {}
  const cacheFile = path.join(rootFolder, '.sandstone', 'cache.json')

  if (cache === undefined) {
    try {
      const fileRead = await fs.readFile(cacheFile, 'utf8')
      if (fileRead) {
        cache = JSON.parse(fileRead)
      }
    } catch {
      cache = {}
    }
  }

  // Run beforeSave script
  await scripts?.beforeSave?.()

  // File exclusion setup
  const excludeOption = saveOptions.resources?.exclude
  const fileExclusions = excludeOption
    ? {
        generated: (excludeOption.generated || excludeOption) as RegExp[] | undefined,
        existing: (excludeOption.existing || excludeOption) as RegExp[] | undefined,
      }
    : false

  const fileHandlers = (saveOptions.resources?.handle as {
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
          newCache[relativePath] = hashValue

          if (cache[relativePath] === hashValue) {
            return
          }

          const realPath = path.join(outputFolder, relativePath)
          await fs.ensureDir(path.dirname(realPath))
          return await fs.writeFile(realPath, content)
        }
      }),
  })

  // Handle resources folder
  async function handleResources(packType: string) {
    const working = path.join(rootFolder, 'resources', packType)

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
        newCache[relativePath] = hashValue

        if (cache[relativePath] !== hashValue) {
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

    const archive = new AdmZip()
    await archive.addLocalFolderPromise(input, {})
    await fs.ensureDir(path.join(outputFolder, 'archives'))
    await archive.writeZipPromise(
      path.join(outputFolder, 'archives', `${packName}_${packType.type}.zip`),
      { overwrite: true },
    )

    return true
  }

  // Export to client/server
  if (!cliOptions.production) {
    for await (const [, packType] of packTypes) {
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

      let archivedOutput = false
      if (packType.archiveOutput) {
        archivedOutput = await archiveOutput(packType)
      }

      // Handle client export
      if (clientPath) {
        let fullClientPath: string

        if (worldName) {
          fullClientPath = path.join(clientPath, packType.clientPath)
            .replace('$packName$', packName)
            .replace('$worldName$', worldName)
        } else {
          fullClientPath = path.join(clientPath, packType.rootPath).replace('$packName$', packName)
        }

        if (packType.archiveOutput && archivedOutput) {
          const archivePath = path.join(outputFolder, 'archives', `${packName}_${packType.type}.zip`)
          await fs.copyFile(archivePath, `${fullClientPath}.zip`)
        } else {
          await fs.remove(fullClientPath)
          await fs.copy(outputPath, fullClientPath)
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

      if (packType.archiveOutput) {
        await archiveOutput(packType)
      }
    }
  }

  // Clean up old files not in new cache
  const oldFileNames = new Set<string>(Object.keys(cache))
  Object.keys(newCache).forEach((name) => oldFileNames.delete(name))

  for (const name of oldFileNames) {
    try {
      await fs.rm(path.join(outputFolder, name))
    } catch {}
  }

  // Update cache
  cache = newCache
  await fs.ensureDir(path.dirname(cacheFile))
  await fs.writeFile(cacheFile, JSON.stringify(cache))

  // Run afterAll script
  await scripts?.afterAll?.()

  const exports = clientPath ? 'client' : false
  console.log(
    `\nPack(s) compiled!${exports ? ` Exported to ${exports}.` : ''} View output in ./.sandstone/output/\n`,
  )
}

export async function buildCommand(opts: BuildOptions, _folders?: ProjectFolders) {
  const folders = _folders?.projectFolder ? _folders : getProjectFolders(opts.path)

  try {
    await _buildProject(opts, folders)
  } catch (err: any) {
    console.error(chalk.red('Build failed:'), err.message || err)
    if (opts.fullTrace) {
      console.error(err)
    }
  }
}
