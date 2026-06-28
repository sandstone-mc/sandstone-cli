import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'fs-extra'
import chalk from 'chalk'

import { log, initLoggerNoFile } from '../ui/logger.js'
import { getClientPath } from './build/export.js'
import type * as sandstone from 'sandstone'

// Mirror of the default `PackType` paths from `sandstone/src/pack/pack.ts`.
// `clean` doesn't import sandstone's pack class instances (it never runs a
// build), so the standard layouts are duplicated here.
const PACK_TYPE_PATHS = {
  datapack: {
    clientPath: 'saves/$worldName$/datapacks/$packName$',
    serverPath: 'world/datapacks/$packName$',
    rootPath: 'datapacks/$packName$',
  },
  resourcepack: {
    clientPath: 'saves/$worldName$/resources',
    serverPath: 'resource_pack',
    rootPath: 'resourcepacks/$packName$',
  },
} as const

export type CleanOptions = {
  path: string
  world?: string
  clientPath?: string
  serverPath?: string
}

export async function cleanCommand(opts: CleanOptions) {
  initLoggerNoFile()

  const folder = opts.path

  // Load the user's sandstone config to discover packName + saveOptions.
  const configPath = path.join(folder, 'sandstone.config.ts')
  let sandstoneConfig: sandstone.SandstoneConfig
  try {
    const configUrl = pathToFileURL(configPath).toString()
    sandstoneConfig = (await import(configUrl)).default as sandstone.SandstoneConfig
  } catch (e: any) {
    throw new Error(`Could not load "${configPath}": ${e.message || e}`)
  }

  const saveOptions = sandstoneConfig.saveOptions || {}
  const packName = sandstoneConfig.name

  if (!packName) {
    throw new Error(`sandstone.config.ts is missing a "name" field required by clean.`)
  }

  // Read the build cache to pick up any symlinks tracked from prior builds.
  // Per-child symlinks (e.g. when exporting into a world's existing
  // `datapacks/` folder) are recorded here too, so the cache is the
  // authoritative source for symlink paths.
  const cacheFile = path.join(folder, '.sandstone', 'cache.json')
  let cache: { files?: Record<string, string>; symlinks?: string[]; archives?: string[] } = {}
  try {
    const fileRead = await fs.readFile(cacheFile, 'utf8')
    if (fileRead) {
      const parsed = JSON.parse(fileRead)
      cache = parsed.files ? parsed : { files: parsed }
    }
  } catch {
    cache = {}
  }

  // Resolve destination paths the same way `_buildProject` does, so that
  // files copied (rather than symlinked) and `.zip` archives from
  // `exportZips` are also removed.
  const worldName = opts.world || saveOptions.world
  const root = saveOptions.root
  const clientPath = opts.clientPath || saveOptions.clientPath || (await getClientPath().catch(() => undefined))
  const serverPath = opts.serverPath || saveOptions.serverPath

  if (worldName && root) {
    throw new Error("Expected only 'world' or 'root'. Got both.")
  }

  const pathsToDelete = new Set<string>()

  if (cache.symlinks) {
    for (const symlink of cache.symlinks) {
      pathsToDelete.add(symlink)
    }
  }

  for (const [type, paths] of Object.entries(PACK_TYPE_PATHS)) {
    if (clientPath) {
      let clientDest: string
      const useWorldPath = !!worldName && (type !== 'resourcepack' || !!saveOptions.exportZips)
      if (useWorldPath) {
        clientDest = path
          .join(clientPath, paths.clientPath)
          .replace('$packName$', packName)
          .replace('$worldName$', worldName!)
      } else {
        clientDest = path.join(clientPath, paths.rootPath).replace('$packName$', packName)
      }
      pathsToDelete.add(clientDest)
      // Archived resourcepacks (and any future archived pack types) write
      // a `.zip` sibling to the destination rather than the directory.
      pathsToDelete.add(`${clientDest}.zip`)
    }

    if (serverPath) {
      const serverDest = path.join(serverPath, paths.serverPath).replace('$packName$', packName)
      pathsToDelete.add(serverDest)
      pathsToDelete.add(`${serverDest}.zip`)
    }
  }

  let deleted = 0
  for (const targetPath of pathsToDelete) {
    try {
      const stats = await fs.lstat(targetPath)
      if (stats.isSymbolicLink() || stats.isFile()) {
        await fs.unlink(targetPath)
        log(chalk.green('Removed:'), targetPath)
        deleted++
      } else if (stats.isDirectory()) {
        await fs.rm(targetPath, { recursive: true, force: true })
        log(chalk.green('Removed:'), targetPath)
        deleted++
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') continue
      log(chalk.yellow('Warning:'), `Could not delete ${targetPath}: ${e.message || e}`)
    }
  }

  // Trim removed paths from the cache so the next `build` recreates them
  // from scratch instead of preserving stale entries.
  let cacheDirty = false
  if (cache.symlinks) {
    const newSymlinks = cache.symlinks.filter((s) => !pathsToDelete.has(s))
    if (newSymlinks.length !== cache.symlinks.length) {
      cache.symlinks = newSymlinks
      cacheDirty = true
    }
  }

  // Wipe the file-hash cache so the next `build` treats every generated
  // file as changed. The build's `changedPackTypes` set is derived from
  // this hash cache; without this, a clean followed by an unchanged build
  // would skip re-export and leave the symlinks (now deleted) unrestored.
  if (cache.files && Object.keys(cache.files).length > 0) {
    cache.files = {}
    cacheDirty = true
  }

  if (cacheDirty) {
    await fs.ensureDir(path.dirname(cacheFile))
    await fs.writeFile(cacheFile, JSON.stringify(cache))
  }

  if (deleted === 0) {
    log('No external file or symlink locations found to clean.')
  } else {
    log(`Cleaned ${deleted} external location${deleted === 1 ? '' : 's'}.`)
  }
}
