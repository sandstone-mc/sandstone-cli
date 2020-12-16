import path from 'path'
import crypto from 'crypto'
import { promisify } from 'util'
import { exit } from 'process'
import fs from 'fs-extra'

const sandstoneLocation = path.resolve('./node_modules/sandstone')

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
 */
type SandstoneCache = {
  rootFolder?: string
  files: Record<string, string>
}

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

const sandstoneCacheFolder = '.sandstone'
const sandstoneCachePath = path.join(sandstoneCacheFolder, 'cache.json')

 export async function buildProject(options: BuildOptions) {
  if (options.namespace) {
    process.env.NAMESPACE = options.namespace
  }

  // First, read sandstone.config.ts to get all properties
  const sandstoneConfig = require(path.join(sandstoneLocation, '_internals/config')).getConfigFile()

  const { saveOptions } = sandstoneConfig

  const { savePack } = require(path.join(sandstoneLocation, 'core'))

  // Check if the player overidded the save options
  const overrideSaveOptions = options.world || options.root || options.path
  const world = overrideSaveOptions ? options.world : saveOptions.world
  const root = overrideSaveOptions ? options.root : saveOptions.root
  const customPath = overrideSaveOptions ? options.path : saveOptions.path

  const dataPackName = options.name ?? sandstoneConfig.name

  if ([world, root, customPath].filter(x => x !== undefined).length > 1) {
    throw new Error(`Expected only 'world', 'root' or 'path'. Got at least two of them: world=${world}, root=${root}, path=${customPath}`)
  }

  // The configuration is ready. Let's import all .ts & .js files under ./src.
  let error = false
  for await (const filePath of walk('./src')) {
    // Skip files not ending with .ts/.js
    if (!filePath.match(/\.(ts|js)$/)) { continue }

    // We have a module, let's require it!
    try { 
      require(path.resolve(filePath))
    }
    catch(e) {
      console.error(e)
      error = true
    }
  }

  if (error) {
    exit(-1)
  }

  /* Let's load the previous cache */

  // Create .sandstone if it doesn't exists
  mkDir(sandstoneCacheFolder)

  // Try loading the cache
  let cache: SandstoneCache
  const newCache: SandstoneCache = { files: {} }

  try {
    // Load the cache
    cache = JSON.parse((await fs.readFile(sandstoneCachePath)).toString())
  }
  catch(e) {
    // Either the file does not exists, or the cache isn't a proper JSON.
    // In that case, reset it.
    cache = { files: {} }
    await fs.writeFile(sandstoneCachePath, JSON.stringify(cache))
  }

  // Save the pack
  await savePack(dataPackName, {
    // Save location
    world: world,
    asRootDatapack: root,
    customPath: customPath,
    minecraftPath: options.minecraftPath ?? sandstoneConfig.minecraftPath,

    // Data pack mcmeta
    description: options.description ?? sandstoneConfig.description,
    formatVersion: options.formatVersion ?? saveOptions.formatVersion,

    // Additional parameters
    dryRun: options.dry,
    verbose: options.verbose,

    customFileHandler: saveOptions.customFileHandler ?? (async ({ relativePath, content, rootPath }: SaveFileObject) => {
      const realPath = path.join(rootPath, relativePath)
      const hashValue = hash(content)

      // Add to new cache
      newCache.files[realPath] = hashValue
      newCache.rootFolder = rootPath

      if (cache.files?.[realPath] === hashValue) {
        // Already in cache - skip
        return
      }

      // Not in cache: write to disk
      await mkDir(path.dirname(realPath))
      return await fs.writeFile(realPath, content)
    })
  })

  // Delete old files that aren't cached anymore
  const oldFilesNames = new Set<string>(Object.keys(cache.files))
  Object.keys(newCache.files).forEach(name => oldFilesNames.delete(name))

  await Promise.allSettled(
    [...oldFilesNames.values()].map(name => promisify(fs.rm)(name))
  )

  // Delete all empty folders of previous directory
  if (cache.rootFolder !== undefined) {
    try {
      await removeEmptyDirectories(cache.rootFolder)
    }
    catch (e) {
      // Previous directory was deleted by the user himself
    }
  }

  // Override old cache
  await fs.writeFile(sandstoneCachePath, JSON.stringify(newCache, null, 2))
}