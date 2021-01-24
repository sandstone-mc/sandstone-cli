import path from 'path'
import crypto from 'crypto'
import { promisify } from 'util'
import { exit } from 'process'
import fs from 'fs-extra'
import chalk from 'chalk'
import { ProjectFolders } from './utils'
import PrettyError from 'pretty-error'
import { resolveTripleslashReference } from 'typescript'

const pe = new PrettyError()
  
export type BuildOptions = { 
  world?: string
  root?: boolean
  path?: string
  minecraftPath?: string
  
  namespace?: string

  name?: string
  description?: string
  formatVersion?: number

  dry?: boolean
  verbose?: boolean

  fullTrace?: boolean
}

type SaveFileObject = {
  packType: 'datapack'
  type: string
  rootPath: string
  relativePath: string
  content: string
  resource: any
}

/* 
 * Sandstone files cache is just a key-value pair, 
 * key being the file path & value being the hash.
 * 
 * The folder array is just here to delete folders that get empty after a new compilation.
 * 
 * There is 1 cache for each "project folder".
 */
type SandstoneCache = Record<string, {
  resultFolder?: string
  files: Record<string, string>
}>

/** Recursively walk a directory. */
async function* walk(dir: string): AsyncGenerator<string> {
    for await (const d of await fs.opendir(dir)) {
        const entry = path.join(dir, d.name);
        if (d.isDirectory()) yield* walk(entry);
        else if (d.isFile()) yield entry;
    }
}

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
  catch(error) {
    // Directory already exists
  }
}

/**
 * Recursively removes empty directories from the given directory.
 *
 * If the directory itself is empty, it is also removed.
 *
 * Code taken from: https://gist.github.com/jakub-g/5903dc7e4028133704a4
 *
 * @param {string} directory Path to the directory to clean up
 */
async function removeEmptyDirectories(directory: string) {
    // lstat does not follow symlinks (in contrast to stat)
    const fileStats = await fs.lstat(directory);
    if (!fileStats.isDirectory()) {
        return;
    }
    let fileNames = await fs.readdir(directory);
    if (fileNames.length > 0) {
        const recursiveRemovalPromises = fileNames.map(
            (fileName: string) => removeEmptyDirectories(path.join(directory, fileName)),
        );
        await Promise.all(recursiveRemovalPromises);

        // re-evaluate fileNames; after deleting subdirectory
        // we may have parent directory empty now
        fileNames = await fs.readdir(directory);
    }

    if (fileNames.length === 0) {
        await fs.rmdir(directory);
    }
}

const sandstoneMiscFolderName = '.sandstone'
const sandstoneCacheFileName = 'cache.json'

/**
 * Build the project, but might throw errors.
 * 
 * @param options The options to build the project with.
 * 
 * @param projectFolder The folder of the project. It needs a sandstone.config.ts, and it or one of its parent needs a package.json.
 */
async function _buildProject(options: BuildOptions, {absProjectFolder, rootFolder, sandstoneConfigFolder }: ProjectFolders) {
  const sandstoneLocation = path.join(rootFolder, 'node_modules/sandstone/')

  // First, read sandstone.config.ts to get all properties
  const sandstoneConfig = require(path.join(sandstoneConfigFolder, 'sandstone.config.ts')).default

  const { saveOptions, scripts } = sandstoneConfig

  /// OPTIONS ///
  // Check if the player overidded the save options
  const overrideSaveOptions = options.world || options.root || options.path
  const world = overrideSaveOptions ? options.world : saveOptions.world
  const root = overrideSaveOptions ? options.root : saveOptions.root
  const customPath = overrideSaveOptions ? options.path : saveOptions.path
  
  const minecraftPath = options.minecraftPath ?? sandstoneConfig.minecraftPath
  const dataPackName = options.name ?? sandstoneConfig.name

  if ([world, root, customPath].filter(x => x !== undefined).length > 1) {
    throw new Error(`Expected only 'world', 'root' or 'path'. Got at least two of them: world=${world}, root=${root}, path=${customPath}`)
  }

  // Important /!\: The below if statements, which set environment variables, must run before importing any Sandstone file.

  // Set the pack ID environment variable
  if (sandstoneConfig.packUid) {
    process.env.PACK_UID = sandstoneConfig.packUid
  }
  
  // Set the namespace
  const namespace = sandstoneConfig.namespace || options.namespace
  if (namespace) {
    process.env.NAMESPACE = namespace
  }

  // Configure error display
  if (!options.fullTrace) {
    pe.skipNodeFiles()
  }

  /// IMPORTING USER CODE ///
  // The configuration is ready.
  
  // Now, let's run the beforeAll script
  const { getDestinationPath } = require(path.join(sandstoneLocation, '_internals', 'datapack', 'saveDatapack'))
  const destinationPath = getDestinationPath(dataPackName, { world, asRootDatapack: root, customPath, minecraftPath })

  await scripts?.beforeAll?.({
    dataPackName,
    destination: destinationPath,
  })

  // Finally, let's import all .ts & .js files under ./src.
  let error = false
  for await (const filePath of walk(absProjectFolder)) {
    // Skip files not ending with .ts/.js
    if (!filePath.match(/\.(ts|js)$/)) { continue }

    // We have a module, let's require it!
    try { 
      require(path.resolve(filePath))
    }
    catch(e) {
      logError(e)
      error = true
    }
  }
  
  if (error) {
    return
  }

  /// SAVING RESULTS ///
  /* Let's load the previous cache */

  // Create .sandstone if it doesn't exists
  const sandstoneMiscFolder = path.join(rootFolder, sandstoneMiscFolderName)
  const sandstoneCacheFile = path.join(sandstoneMiscFolder, sandstoneCacheFileName)
  mkDir(sandstoneMiscFolder)

  // Try loading the cache
  let cache: SandstoneCache = {}
  const newCache: SandstoneCache[''] = {
    files: {}
  }

  try {
    // Load the cache
    cache = JSON.parse((await fs.readFile(sandstoneCacheFile)).toString())
  }
  catch(e) {
    // Either the file does not exists, or the cache isn't a proper JSON.
    // In that case, reset it.
    await fs.writeFile(sandstoneCacheFile, JSON.stringify(cache))
  }

  if (cache[absProjectFolder] === undefined) {
    cache[absProjectFolder] = {
      files: {},
    }
  }

  // Save the pack
  const { savePack } = require(path.join(sandstoneLocation, 'core'))

  // Run the beforeSave script
  await scripts?.beforeSave?.({
    dataPackName,
    destination: destinationPath,
  })

  await savePack(dataPackName, {
    // Save location
    world: world,
    asRootDatapack: root,
    customPath: customPath,
    minecraftPath: minecraftPath,
    indentation: saveOptions.indentation,

    // Data pack mcmeta
    description: options.description ?? sandstoneConfig.description,
    formatVersion: options.formatVersion ?? saveOptions.formatVersion,

    // Additional parameters
    dryRun: options.dry,
    verbose: options.verbose,

    customFileHandler: saveOptions.customFileHandler ?? (async ({ relativePath, content }: SaveFileObject) => {
      const realPath = path.join(destinationPath, relativePath)

      // We hash the real path alongside the content. 
      // Therefore, if the real path change (for example, the user changed the resulting directory), the file will be recreated.
      const hashValue = hash(content + realPath)

      // Add to new cache. We use the relative path as key to make the cache lighter.
      newCache.files[relativePath] = hashValue
      newCache.resultFolder = destinationPath

      if (cache[absProjectFolder].files?.[realPath] === hashValue) {
        // Already in cache - skip
        return
      }

      // Not in cache: write to disk
      await mkDir(path.dirname(realPath))
      return await fs.writeFile(realPath, content)
    })
  })

  // Delete old files that aren't cached anymore
  const oldFilesNames = new Set<string>(Object.keys(cache[absProjectFolder].files))
  
  Object.keys(newCache.files).forEach(name => oldFilesNames.delete(name))

  const previousResultFolder = cache?.[absProjectFolder]?.resultFolder
  
  await Promise.allSettled(
    [...oldFilesNames.values()].map(name => promisify(fs.rm)(path.join(previousResultFolder ?? '', name)))
  )

  // Delete all empty folders of previous directory
  if (previousResultFolder !== undefined) {
    try {
      await removeEmptyDirectories(previousResultFolder)
    }
    catch (e) {
      // Previous directory was deleted by the user himself
    }
  }

  // Override old cache
  cache[absProjectFolder] = newCache
  await fs.writeFile(sandstoneCacheFile, JSON.stringify(cache, null, 2))

  
  // Run the afterAll script
  await scripts?.afterAll?.({
    dataPackName,
    destination: destinationPath,
  })
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
  catch (err) {
    logError(err)
  }
}

function logError(err?: Error) {
  if (err) {
    console.error(pe.render(err))
  }
}

process.on('unhandledRejection', logError)
process.on('uncaughtException', logError)