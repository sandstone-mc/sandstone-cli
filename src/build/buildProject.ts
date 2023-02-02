import path from 'path'
import crypto from 'crypto'
import { promisify } from 'util'
import fs from 'fs-extra'
import { ProjectFolders } from '../utils'
import PrettyError from 'pretty-error'
import walk from 'klaw'

import madge from 'madge'
import { DependencyGraph } from './graph'
import chalk from 'chalk'

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
  production?: boolean
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

const cache: SandstoneCache = {}

const dependenciesCache: DependencyGraph = new DependencyGraph({})

type FileResource = {
  resources: Set<{ path: string[], resourceType: string }> // Set<File<Record<never, never>>>
  objectives: Set<any> // Set<ObjectiveClass>
}

const fileResources: Map<string, FileResource> = new Map()

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

function getNewModules(dependenciesGraph: DependencyGraph, rawFiles: { path: string }[], projectFolder: string) {
  const rawFilesPath = rawFiles.map(({ path }) => path)

  // Get only the new modules
  const newModules = [...dependenciesGraph.nodes.values()].filter(
    (node) => rawFilesPath.includes(path.join(projectFolder, node.name))
  )

  // Get their dependants, as a set to avoid duplicates
  const newModulesDependencies = new Set(
    newModules.flatMap((node) => [...node.getDependsOn({ recursive: true, includeSelf: true })])
  )

  // Sort them by number of dependencies, and return them
  return [...newModulesDependencies].sort(
    (a, b) => a.getDependencies({ recursive: true }).size - b.getDependencies({ recursive: true }).size
  )
}

/**
 * Returns a set of all values present in set1 and not present in set2.
 */
function diffSet<T extends unknown>(set1: Set<T>, set2: Set<T>): T {
  return [...set1].filter((element) => !set2.has(element)) as any
}

/**
 * Returns a map of all key/value present in map1 and not present in map2.
 */
function diffMap<T extends unknown>(map1: Map<string, T>, map2: Map<string, T>): Map<string, T> {
  return new Map([...map1.entries()].filter(([key, value]) => !map2.has(key)))
}

function diffResources(tree1: any, tree2: any): Set<{ path: string[], resourceType: string }> {
  return tree1.diff(tree2)
}

/**
 * Build the project, but might throw errors.
 *
 * @param options The options to build the project with.
 *
 * @param projectFolder The folder of the project. It needs a sandstone.config.ts, and it or one of its parent needs a package.json.
 */
async function _buildProject(options: BuildOptions, { absProjectFolder, rootFolder, sandstoneConfigFolder }: ProjectFolders, resourceTypes: string[], changedFiles?: string[]) {
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
  const packName = options.name ?? sandstoneConfig.name

  if ([world, root, customPath].filter(x => x !== undefined).length > 1) {
    throw new Error(`Expected only 'world', 'root' or 'path'. Got at least two of them: world=${world}, root=${root}, path=${customPath}`)
  }

  // Important /!\: The below if statements, which set environment variables, must run before importing any Sandstone file.

  // Set the pack ID environment variable

  // Set production/development mode
  if (options.production) {
    process.env.SANDSTONE_ENV = 'production'
  } else {
    process.env.SANDSTONE_ENV = 'development'
  }

  if (sandstoneConfig.packUid) {
    process.env.PACK_UID = sandstoneConfig.packUid
  }

  // Set the namespace
  const namespace = sandstoneConfig.namespace || options.namespace
  if (namespace) {
    process.env.NAMESPACE = namespace
  }

  const { onConflict } = sandstoneConfig
  if (onConflict) {
    if (onConflict.default) {
      process.env[`GENERAL_CONFLICT_STRATEGY`] = onConflict.default
    }
    for (const resource of resourceTypes) {
      if (onConflict[resource]) {
        process.env[`${resource.toUpperCase()}_CONFLICT_STRATEGY`] = onConflict[resource]
      }
    }
  }

  // Configure error display
  if (!options.fullTrace) {
    pe.skipNodeFiles()
  }

  /// IMPORTING USER CODE ///
  // The configuration is ready.

  // Now, let's run the beforeAll script
  const { getDestinationPath } = require(path.join(sandstoneLocation, 'pack', 'pack'))
  const destinationPath = getDestinationPath(packName, { world, asRootDatapack: root, customPath, minecraftPath })

  await scripts?.beforeAll?.({
    packName,
    destination: destinationPath,
  })

  // Finally, let's import all .ts & .js files under ./src.
  let error = false

  // Get the list of all files
  const rawFiles: { path: string }[] = []
  for await (const file of walk(absProjectFolder)) {
    rawFiles.push(file)
  }

  const changedFilesPaths = changedFiles?.map(file => ({ path: file }))

  /**
   * 1. Update dependency graphs
   * 2. Delete all cache & resources for files dependent from the changed files
   * 3. Import all changed files, & their dependents
   * 4. Save only newly created resources
   */
  const graph = await madge(rawFiles.map(f => f.path).filter(f => !f.endsWith('.json')), {
    fileExtensions: ['.ts', '.cts', '.mts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.json'],
    includeNpm: false,
    baseDir: absProjectFolder,


    detectiveOptions: {
      es6: {
        skipTypeImports: true,
      },
      ts: {
        skipTypeImports: true,
      },
    },
  })

  // This dependencies graph is only partial.
  const dependenciesGraph = new DependencyGraph(graph.obj())

  // Update the global dependency graph by merging it with the new one.
  dependenciesCache.merge(dependenciesGraph)

  // Transform resolved dependents into a flat list of files, and sort them by their number of dependencies
  const newModules = getNewModules(dependenciesCache, changedFilesPaths ?? rawFiles, absProjectFolder)

  const { SandstonePack } = require(sandstoneLocation)

  // If files changed, we need to clean the cache & delete the related resources
  //if (changedFiles) {
  //  for (const node of newModules) {
  //    // For eached changed file, we need to reset the require cache
  //    delete require.cache[path.join(absProjectFolder, node.name)]

  //    // Then we need to delete all resources the file created
  //    const oldResources = fileResources.get(node.name)
  //    if (oldResources) {
  //      const { resources, customResources, objectives, rootFunctions } = oldResources

  //      for (const resource of resources) {
  //        SandstonePack.core.deleteResource(resource.path, resource.resourceType)
  //      }

  //      for (const resource of customResources) {
  //        SandstonePack.core.customResources.delete(resource)
  //      }

  //      for (const rootFunction of rootFunctions) {
  //        dataPack.rootFunctions.delete(rootFunction)
  //      }
  //    }
  //  }
  //}

  // Now, let's build the file & its dependents. First files to be built are the ones with less dependencies.
  for (const node of newModules) {
    const modulePath = path.join(absProjectFolder, node.name)

    const currentResources: FileResource = {
      resources: new Set([...SandstonePack.core.resourceNodes]),
      objectives: new Set([...SandstonePack.objectives.entries()])
    }

    // We have a module, let's require it!
    const filePath = path.resolve(modulePath)
    try {
      // Sometimes, a file might not exist because it has been deleted.
      if (await fs.pathExists(filePath)) {
        require(filePath)
      }
    }
    catch (e: any) {
      logError(e, node.name)
      error = true
    }

    // Now, find the resources that were added by this file & store them.
    // This will be used if those files are changed later.
    const newResources: FileResource = {
      resources: diffResources(SandstonePack.core.resourceNodes, currentResources.resources),
      objectives: diffSet(SandstonePack.objectives, currentResources.objectives),
    }

    fileResources.set(node.name, newResources)
  }

  if (error) {
    return
  }

  /// SAVING RESULTS ///
  // Setup the cache if it doesn't exist.
  // This cache is here to avoid writing files on disk when they did not change.
  const newCache: SandstoneCache[string] = {
    files: {}
  }

  if (cache[absProjectFolder] === undefined) {
    cache[absProjectFolder] = {
      files: {},
    }
  }

  // Save the pack

  // Run the beforeSave script
  await scripts?.beforeSave?.({
    packName,
    destination: destinationPath,
  })

  await SandstonePack.save(/*packName, {
    // Save location
    world: world,
    asRootDatapack: root,
    customPath: customPath,
    minecraftPath: minecraftPath,
    indentation: saveOptions.indentation,

    // Data pack mcmeta
    description: options.description ?? sandstoneConfig.description,
    formatVersion: options.formatVersion ?? sandstoneConfig.formatVersion,

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
  }*/)

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

  // Run the afterAll script
  await scripts?.afterAll?.({
    packName,
    destination: destinationPath,
  })
}

/**
 * Build the project. Will log errors and never throw any.
 *
 * @param options The options to build the project with.
 *
 * @param projectFolder The folder of the project. It needs a sandstone.config.ts, and it or one of its parent needs a package.json.
 *
 * @param changedFiles The files that changed since the last build.
 */
export async function buildProject(options: BuildOptions, folders: ProjectFolders, resourceTypes: string[], changedFiles?: string[]) {
  try {
    await _buildProject(options, folders, resourceTypes, changedFiles)
  }
  catch (err: any) {
    logError(err)
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
    console.error(pe.render(err))
  }
}

process.on('unhandledRejection', logError)
process.on('uncaughtException', logError)
