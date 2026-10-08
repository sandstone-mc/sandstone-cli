import path from 'path'
import { loadSandstoneConfig } from '../utils/sandstoneConfig.js'
import chalk from 'chalk'

import { Logger } from '../utils/logger.js'
import { getClientPath, type SandstoneCache } from './build/export.js'
import * as fs from '../utils/fs.js'
import type * as sandstone from 'sandstone'

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
  const sink = Logger.setupConsoleSink()
  const log = (...args: unknown[]) => sink.log(...args)
  const folder = opts.path

  // Load the user's sandstone config to discover packName + saveOptions.
  const sandstoneConfig = await loadSandstoneConfig(folder)
  if (!sandstoneConfig) {
    throw new Error(`Could not load "${path.join(folder, 'sandstone.config.ts')}"`)
  }

  const saveOptions = sandstoneConfig.saveOptions || {}
  const packName = sandstoneConfig.name

  if (!packName) {
    throw new Error(`sandstone.config.ts is missing a "name" field required by clean.`)
  }

  const cacheFile = path.join(folder, '.sandstone', 'cache.json')
  let cache: SandstoneCache = { files: {} }
  try {
    const fileRead = await fs.readText(cacheFile)
    if (fileRead) {
      const parsed = JSON.parse(fileRead)
      cache = parsed.files ? parsed : { files: parsed }
    }
  } catch {
    cache = { files: {} }
  }

  const worldName = opts.world || saveOptions.world
  const root = saveOptions.root
  const clientPath = opts.clientPath || saveOptions.clientPath || (await getClientPath(sink).catch(() => undefined))
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
      const shouldArchive = cache.packTypeExportZips?.[type] ?? false
      const useWorldPath = !!worldName && (type !== 'resourcepack' || shouldArchive)
      if (useWorldPath) {
        clientDest = path
          .join(clientPath, paths.clientPath)
          .replace('$packName$', packName)
          .replace('$worldName$', worldName!)
      } else {
        clientDest = path.join(clientPath, paths.rootPath).replace('$packName$', packName)
      }
      pathsToDelete.add(clientDest)
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
      const stats = await fs.fileLstat(targetPath)
      if (stats.isSymbolicLink() || stats.isFile()) {
        await fs.unlinkPath(targetPath)
        log(chalk.green('Removed:'), targetPath)
        deleted++
      } else if (stats.isDirectory()) {
        await fs.remove(targetPath, { recursive: true, force: true })
        log(chalk.green('Removed:'), targetPath)
        deleted++
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') continue
      log(chalk.yellow('Warning:'), `Could not delete ${targetPath}: ${e.message || e}`)
    }
  }

  let cacheDirty = false
  if (cache.symlinks) {
    const newSymlinks = cache.symlinks.filter((s) => !pathsToDelete.has(s))
    if (newSymlinks.length !== cache.symlinks.length) {
      cache.symlinks = newSymlinks
      cacheDirty = true
    }
  }
  if (cache.files && Object.keys(cache.files).length > 0) {
    cache.files = {}
    cacheDirty = true
  }

  if (cacheDirty) {
    await fs.ensureDir(path.dirname(cacheFile))
    await fs.writeJSON(cacheFile, cache, { pretty: false })
  }

  if (deleted === 0) {
    log('No external file or symlink locations found to clean.')
  } else {
    log(`Cleaned ${deleted} external location${deleted === 1 ? '' : 's'}.`)
  }
}
