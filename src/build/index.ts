import path from 'path'
import * as os from 'os'
import crypto from 'crypto'
import { pathToFileURL } from 'url'
import fs from 'fs-extra'
import PrettyError from 'pretty-error'
import walk from 'klaw'

import chalk from 'chalk'
import AdmZip from 'adm-zip'
import deleteEmpty from 'delete-empty'
import { ProjectFolders } from '../utils.js'

type BuildOptions = {
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

    // TODO: implement ssh
    ssh?: any

    dependencies?: [string, string][]
}

const pe = new PrettyError()

type SaveFileObject = {
  relativePath: string
  content: any
  contentSummary: string
}

/*
 * Sandstone files cache is just a key-value pair,
 * key being the file path & value being the hash.
 */
type SandstoneCache = Record<string, string>

// Return the hash of a string
function hash(stringToHash: string): string {
  return crypto.createHash('md5').update(stringToHash).digest('hex')
}

// Recursively create a directory, without failing if it already exists
async function mkDir(dirPath: string) {
  try {
    await new Promise<void>((resolve, reject) => {
      fs.mkdir(dirPath, { recursive: true }, (err) => {
        if (err) reject(err)
        resolve()
      })
    })
  }
  catch (error) {
    // Directory already exists
  }
}

let cache: SandstoneCache

/**
 *
 * @param worldName The name of the world
 * @param minecraftPath The optional location of the .minecraft folder.
 * If left unspecified, the .minecraft will be found automatically.
 */
async function getClientWorldPath(worldName: string, minecraftPath: string | undefined = undefined) {
  let mcPath: string

  if (minecraftPath) {
    mcPath = minecraftPath
  } else {
    mcPath = (await getClientPath())!
  }

  const savesPath = path.join(mcPath, 'saves')
  const worldPath = path.join(savesPath, worldName)

  if (!fs.existsSync(worldPath)) {
    const existingWorlds = (await fs.readdir(savesPath, { withFileTypes: true })).filter((f: any) => f.isDirectory).map((f: {name: string}) => f.name) as string[]

    throw new Error(`Unable to locate the "${worldPath}" folder. Word ${worldName} does not exists. List of existing worlds: ${JSON.stringify(existingWorlds, null, 2)}`)
  }

  return worldPath
}

/**
 * Get the .minecraft path
 */
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
  } catch (e) {
    console.warn('Unable to locate the .minecraft folder. Will not be able to export to client.')

    return undefined
  }

  return mcPath
}

/**
 * Build the project, but might throw errors.
 *
 * @param cliOptions The options to build the project with.
 *
 * @param projectFolder The folder of the project. It needs a sandstone.config.ts, and it or one of its parent needs a package.json.
 */
async function _buildProject(cliOptions: BuildOptions, { absProjectFolder, projectFolder, rootFolder, sandstoneConfigFolder }: ProjectFolders) {

  // First, read sandstone.config.ts to get all properties
  const sandstoneConfig = (await import(pathToFileURL(path.join(sandstoneConfigFolder, 'sandstone.config.ts')).toString())).default

  const { scripts } = sandstoneConfig

  let { saveOptions } = sandstoneConfig

  if (saveOptions === undefined) saveOptions = {}

  const outputFolder = path.join(rootFolder, '.sandstone', 'output')

  /// OPTIONS ///
  const clientPath = !cliOptions.production ? (cliOptions.clientPath || saveOptions.clientPath || await getClientPath()) : undefined
  const server = !cliOptions.production && (cliOptions.serverPath || saveOptions.serverPath || cliOptions.ssh || saveOptions.ssh) ? await (async () => {
    if (cliOptions.ssh || saveOptions.ssh) {
      const sshOptions = JSON.stringify(await fs.readFile(cliOptions.ssh || saveOptions.ssh, 'utf8'))

      // TODO: implement SFTP
      return {
        readFile: async (relativePath: string, encoding: fs.EncodingOption = 'utf8') => {},
        writeFile: async (relativePath: string, contents: any) => {},
        remove: async (relativePath: string) => {},
      }
    }
    const serverPath = cliOptions.serverPath || saveOptions.serverPath
    return {
      readFile: async (relativePath: string, encoding: fs.EncodingOption = 'utf8') => await fs.readFile(path.join(serverPath, relativePath), encoding),
      writeFile: async (relativePath: string, contents: any) => {
        if (contents === undefined) {
          await fs.unlink(path.join(serverPath, relativePath))
        } else {
          await fs.writeFile(path.join(serverPath, relativePath), contents)
        }
      },
      remove: async (relativePath: string) => await fs.remove(path.join(serverPath, relativePath))
    }
  })() : undefined
  let worldName: undefined | string = cliOptions.world || saveOptions.world
  // Make sure the world exists
  if (worldName && !cliOptions.production) {
    await getClientWorldPath(worldName, clientPath)
  }
  const root = cliOptions.root !== undefined ? cliOptions.root : saveOptions.root

  const packName: string = cliOptions.name ?? sandstoneConfig.name

  if (worldName && root) {
    throw new Error(`Expected only 'world' or 'root'. Got both.`)
  }

  // Important /!\: The below if statements, which set environment variables, must run before importing any Sandstone file.

  // Set the pack ID environment variable

  // Set production/development mode
  if (cliOptions.production) {
    process.env.SANDSTONE_ENV = 'production'
  } else {
    process.env.SANDSTONE_ENV = 'development'
  }

  process.env.WORKING_DIR = absProjectFolder

  if (sandstoneConfig.packUid) {
    process.env.PACK_UID = sandstoneConfig.packUid
  }

  // Set the namespace
  const namespace = cliOptions.namespace || sandstoneConfig.namespace
  if (namespace) {
    process.env.NAMESPACE = namespace
  }

  for (const [k, pack] of Object.entries(sandstoneConfig.packs) as any[]) {
    if (pack.onConflict) {
      for (const resource of Object.entries(pack.onConflict)) {
        process.env[`${resource[0].toUpperCase()}_CONFLICT_STRATEGY`] = resource[1] as string
      }
    }
  }

  // JSON indentation
  process.env.INDENTATION = saveOptions.indentation

  // Pack mcmeta
  process.env.PACK_OPTIONS = JSON.stringify(sandstoneConfig.packs)

  // Configure error display
  if (!cliOptions.fullTrace) {
    pe.skipNodeFiles()
  }

  /// IMPORTING USER CODE ///
  // The configuration is ready.

  // Now, let's run the beforeAll script
  await scripts?.beforeAll?.()

  // Finally, let's import from the index.
  let error = false

  let sandstonePack: any

  const filePath = path.join(projectFolder, 'index.ts')

  try {
    // Sometimes, a file might not exist because it has been deleted.
    if (await fs.pathExists(filePath)) {
      sandstonePack = (await import(pathToFileURL(filePath).toString())).default
    }
  }
  catch (e: any) {
    logError(e, absProjectFolder)
    error = true
  }

  if (error) {
    return
  }

  /// Add new dependencies ///
  if (cliOptions.dependencies) {
    for (const dependency of cliOptions.dependencies) {
      sandstonePack.core.depend(...dependency)
    }
  }

  /// SAVING RESULTS ///
  // Setup the cache if it doesn't exist.
  // This cache is here to avoid writing files on disk when they did not change.
  const newCache: SandstoneCache = {}

  const cacheFile = path.join(rootFolder, '.sandstone', 'cache.json')

  if (cache === undefined) {
    let oldCache: SandstoneCache | undefined
    try {
      const fileRead = await fs.readFile(cacheFile, 'utf8')
      if (fileRead) {
        oldCache = JSON.parse(fileRead)
      }
    } catch {}
    if (oldCache) {
      cache = oldCache
    } else {
      cache = {}
    }
  }

  // Save the pack

  // Run the beforeSave script (TODO: This is where sandstone-server will remove restart env vars)
  await scripts?.beforeSave?.()

  const excludeOption = saveOptions.resources?.exclude

  const fileExclusions = excludeOption ? {
    generated: (excludeOption.generated || excludeOption) as RegExp[] | undefined,
    existing: (excludeOption.existing || excludeOption) as RegExp[] | undefined
  } : false

  const fileHandlers = saveOptions.resources?.handle as ({ path: RegExp, callback: (contents: string | Buffer | Promise<Buffer>) => Promise<Buffer> })[] || false

  const packTypes = await sandstonePack.save({
    // Additional parameters
    dry: cliOptions.dry,
    verbose: cliOptions.verbose,

    fileHandler: saveOptions.customFileHandler ?? (async (relativePath: string, content: any) => {
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
        // We hash the relative path alongside the content to ensure unique hash.
        const hashValue = hash(content + relativePath)

        // Add to new cache.
        newCache[relativePath] = hashValue

        if (cache[relativePath] === hashValue) {
          // Already in cache - skip
          return
        }

        // Not in cache: write to disk
        const realPath = path.join(outputFolder, relativePath)

        await mkDir(path.dirname(realPath))
        return await fs.writeFile(realPath, content)
      }
    })
  })

  async function handleResources(packType: string) {
    const working = path.join(rootFolder, 'resources', packType)

    let exists = false

    try {
      await fs.access(working)
      exists = true
    } catch (e) {}

    if (exists) {
      for await (const file of walk(path.join(rootFolder, 'resources', packType), { filter: (_path) => {
        const relativePath = path.join(packType, _path.split(working)[1])
        let pathPass = true
        if (fileExclusions && fileExclusions.existing) {
          for (const exclude of fileExclusions.existing) {
            pathPass = Array.isArray(exclude) ? !exclude[0].test(relativePath) : !exclude.test(relativePath)
          }
        }
        return pathPass
      }})) {
        const relativePath = path.join(packType, file.path.split(working)[1])

        try {
          let content = await fs.readFile(file.path)

          if (fileHandlers) {
            for (const handler of fileHandlers) {
              if (handler.path.test(relativePath)) {
                content = await handler.callback(content)
              }
            }
          }

          // We hash the relative path alongside the content to ensure unique hash.
          const hashValue = hash(content + relativePath)

          // Add to new cache.
          newCache[relativePath] = hashValue

          if (cache[relativePath] !== hashValue) {
            // Not in cache: write to disk
            const realPath = path.join(outputFolder, relativePath)

            await mkDir(path.dirname(realPath))
            await fs.writeFile(realPath, content)
          }
        } catch (e) {}
      }
    }
  }

  async function archiveOutput(packType: any) {
    const input = path.join(outputFolder, packType.type)

    if ((await fs.readdir(input)).length !== 0) {
      const archive = new AdmZip()

      await archive.addLocalFolderPromise(input, {})

      await archive.writeZipPromise(`${path.join(outputFolder, 'archives', `${packName}_${packType.type}`)}.zip`, { overwrite: true })

      return true
    }

    return false
  }

  // TODO: implement linking to make the cache more useful when not archiving.
  if (!cliOptions.production) {
    for await (const _packType of packTypes) {
      const packType = _packType[1]
      const outputPath = path.join(outputFolder, packType.type)

      await fs.ensureDir(outputPath)

      if (packType.handleOutput) {
        await packType.handleOutput(
          'output',
          async (relativePath: string, encoding: fs.EncodingOption = 'utf8') => await fs.readFile(path.join(outputPath, relativePath), encoding),
          async (relativePath: string, contents: any) => {
            if (contents === undefined) {
              await fs.unlink(path.join(outputPath, relativePath))
            } else {
              await fs.writeFile(path.join(outputPath, relativePath), contents)
            }
          }
        )
      }

      handleResources(packType.type)

      let archivedOutput = false

      if (packType.archiveOutput) {
        archivedOutput = await archiveOutput(packType)
      }

      // Handle client
      if (!(server && packType.networkSides === 'server') && clientPath) {
        let fullClientPath: string

        if (worldName) {
          fullClientPath = path.join(clientPath, packType.clientPath)

          try { fullClientPath = fullClientPath.replace('$packName$', packName) } catch {}
          try { fullClientPath = fullClientPath.replace('$worldName$', worldName) } catch {}
        } else {
          fullClientPath = path.join(clientPath, packType.rootPath)

          try { fullClientPath = fullClientPath.replace('$packName$', packName) } catch {}
        }

        if (packType.archiveOutput) {
          if (archivedOutput) {
            await fs.copyFile(`${path.join(outputFolder, 'archives', `${packName}_${packType.type}`)}.zip`, `${fullClientPath}.zip`)
          }
        } else {
          await fs.remove(fullClientPath)

          await fs.copy(outputPath, fullClientPath)
        }

        if (packType.handleOutput) {
          await packType.handleOutput(
            'client',
            async (relativePath: string, encoding: fs.EncodingOption = 'utf8') => await fs.readFile(path.join(clientPath, relativePath), encoding),
            async (relativePath: string, contents: any) => {
              if (contents === undefined) {
                fs.unlink(path.join(clientPath, relativePath))
              } else {
                await fs.writeFile(path.join(clientPath, relativePath), contents)
              }
            }
          )
        }
      }

      // Handle server
      if (server && (packType.networkSides === 'server' || packType.networkSides === 'both')) {
        let serverPath: string = packType.serverPath

        try { serverPath = serverPath.replace('$packName$', packName) } catch {}

        if (packType.archiveOutput && archivedOutput) {
          await server.writeFile(await fs.readFile(`${outputPath}.zip`, 'utf8'), `${serverPath}.zip`)
        } else {
          server.remove(serverPath)
          for await (const file of walk(outputPath)) {
            await server.writeFile(path.join(serverPath, file.path.split(outputPath)[1]), await fs.readFile(file.path))
          }
        }

        if (packType.handleOutput) {
          await packType.handleOutput('server', server.readFile, server.writeFile)
        }
      }
    }
  } else {
    for await (const packType of packTypes) {
      const outputPath = path.join(outputFolder, packType.type)

      if (packType.handleOutput) {
        await packType.handleOutput(
          'output',
          async (relativePath: string, encoding: fs.EncodingOption = 'utf8') => await fs.readFile(path.join(outputPath, relativePath), encoding),
          async (relativePath: string, contents: any) => {
            if (contents === undefined) {
              await fs.unlink(path.join(outputPath, relativePath))
            } else {
              await fs.writeFile(path.join(outputPath, relativePath), contents)
            }
          }
        )
      }

      handleResources(packType.type)

      if (packType.archiveOutput) {
        archiveOutput(packType)
      }
    }
  }

  // Delete old files that aren't cached anymore
  const oldFilesNames = new Set<string>(Object.keys(cache))

  Object.keys(newCache).forEach(name => oldFilesNames.delete(name))

  for await (const name of oldFilesNames) {
    await fs.rm(path.join(outputFolder, name))
  }

  await deleteEmpty(outputFolder)


  // Override old cache
  cache = newCache

  // Write the cache to disk
  await fs.writeFile(cacheFile, JSON.stringify(cache))

  // Run the afterAll script
  await scripts?.afterAll?.()

  console.log(`Pack(s) compiled! View output in ./.sandstone/output/`)
}

/**
 * Build the project. Will log errors and never throw any.
 *
 * @param options The options to build the project with.
 *
 * @param projectFolder The folder of the project. It needs a sandstone.config.ts, and it or one of its parent needs a package.json.
 */
export async function buildProject(options: BuildOptions, folders: ProjectFolders) {
  try {
    await _buildProject(options, folders)
  }
  catch (err: any) {
    console.log(err)
  }
}

function logError(err?: Error, file?: string) {
  if (err) {
    if (file) {
      console.error(
        '  ' + chalk.bgRed.white('BuildError') + chalk.gray(':'),
        `While loading "${file}", the following error happened:\n`
      )
    }
    debugger
    console.error(pe.render(err))
  }
}

process.on('unhandledRejection', logError)
process.on('uncaughtException', logError)
