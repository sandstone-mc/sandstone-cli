import path from 'path'
import os from 'os'
import AdmZip from 'adm-zip'

import type { LoggerSink } from '../../utils/logger.js'
import { canUseSymlinks } from '../../utils/index.js'
import * as fs from '../../utils/fs.js'
import type * as sandstone from 'sandstone'
import type { PackType } from 'sandstone/pack'

export type SandstoneCache = {
  files: Record<string, string>
  archives?: string[]
  canUseSymlinks?: boolean
  symlinks?: string[]
  perChildEntries?: Record<string, string[]>
  packTypeExportZips?: Record<string, boolean>
}

// Module-level symlink availability cache
let symlinksAvailable: boolean | undefined

export async function checkSymlinksAvailable(local: sandstone.BeforeSaveLocal, sink: LoggerSink): Promise<boolean> {
  if (symlinksAvailable === undefined) {
    const cached = local.oldCache?.canUseSymlinks
    if (cached !== undefined) {
      symlinksAvailable = cached
    } else {
      symlinksAvailable = await canUseSymlinks()
    }
  }
  return symlinksAvailable
}

export function getSymlinksAvailable(): boolean {
  return symlinksAvailable ?? false
}

// Minecraft path detection

function getMCPath(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(os.homedir(), 'AppData/Roaming/.minecraft')
    case 'darwin':
      return path.join(os.homedir(), 'Library/Application Support/minecraft')
    case 'linux':
    default:
      return path.join(os.homedir(), '.minecraft')
  }
}

export async function getClientPath(sink: LoggerSink): Promise<string | undefined> {
  const mcPath = getMCPath()

  try {
    await fs.fileLstat(mcPath)
  } catch {
    sink.log('Unable to locate the .minecraft folder. Will not be able to export to client.')
    return undefined
  }

  return mcPath
}

export async function getClientWorldPath(worldName: string, minecraftPath: string | undefined, sink: LoggerSink): Promise<string> {
  const mcPath = minecraftPath ?? (await getClientPath(sink))!
  const savesPath = path.join(mcPath, 'saves')
  const worldPath = path.join(savesPath, worldName)

  if (!(await fs.pathExists(worldPath))) {
    const existingWorlds: string[] = []
    try {
      const entries = await fs.readDirNames(savesPath)
      // Filter to dirs via per-entry stat; saves/ is small enough that
      // the parallel stat pass is cheaper than re-implementing readdir
      // with a custom Dirent filter.
      await Promise.all(entries.map(async (name) => {
        try {
          const s = await fs.fileLstat(path.join(savesPath, name))
          if (s.isDirectory()) existingWorlds.push(name)
        } catch { /* skip */ }
      }))
    } catch { /* saves/ missing — report empty list */ }

    throw new Error(
      `Unable to locate the "${worldPath}" folder. World ${worldName} does not exist. List of existing worlds: ${JSON.stringify(existingWorlds, null, 2)}`,
    )
  }

  return worldPath
}

// Symlink handling

export async function createSymlink(
  folder: string,
  packName: string,
  newCache: SandstoneCache,
  minecraftPath: string,
  targetPath: string,
  sink: LoggerSink,
  linkPath: string
) {
  let rawPath = path.resolve(path.join(folder))
  let sep: string = path.sep
  if (process.platform === 'win32') {
    sep = `${path.sep}${path.sep}`
    rawPath = rawPath.replaceAll(path.sep, sep)
  }
  const allowPath = `[glob]${rawPath}${sep}**${sep}*`

  const allowedList = path.join(minecraftPath, 'allowed_symlinks.txt')

  const comment = `# Sandstone Pack: ${packName}\n`
  try {
    const currentlyAllowed = (await fs.readText(allowedList)).replace(/\r/g, '')

    if (currentlyAllowed.split('\n').includes(allowPath)) {
      sink.log('[symlink] Workspace already in allowed_symlinks.txt, skipping...')
    } else {
      sink.log('[symlink] Adding workspace to allowed_symlinks.txt. If the game is running please restart it.')

      const separator = currentlyAllowed.length > 0
        ? (currentlyAllowed.endsWith('\n') ? '' : '\n') + '#\n'
        : ''
      await fs.writeText(allowedList, currentlyAllowed + separator + comment + allowPath)
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e

    sink.log('[symlink] Creating allowed_symlinks.txt. If the game is running please restart it.')
    await fs.writeText(allowedList, `${comment}${allowPath}`)
  }

  // Inspect what (if anything) exists at linkPath
  let isExistingDirectory = false
  let skip = false
  let errored = false
  try {
    const stats = await fs.fileLstat(linkPath)
    if (stats.isSymbolicLink() && await fs.readSymlink(linkPath) === path.resolve(targetPath)) {
      sink.log('[symlink] Symlink already created, skipping...')
      skip = true
    } else if (stats.isDirectory()) {
      isExistingDirectory = true
    } else {
      errored = true
    }
  } catch {}

  if (errored) {
    throw new Error(`Tried to add a symlink at "${linkPath}",\n encountered an existing FS entry.`)
  }

  // If linkPath already exists as a directory, symlink each active child
  // (per `newCache.perChildEntries[packTypeName]`) into it individually,
  // instead of replacing the directory with a symlink to targetPath.
  if (isExistingDirectory) {
    sink.log(`[symlink] ${linkPath} already exists as a directory; symlinking its children individually.`)
    const perChildEntries = newCache.perChildEntries?.[linkPath]

    if (!perChildEntries || perChildEntries.length === 0) {
      sink.log(`[symlink] No active per-child entries for ${linkPath}; leaving existing directory untouched.`)
      return
    }

    for (const childName of perChildEntries) {
      if (childName.includes(sep)) continue
      const childTarget = path.join(targetPath, childName)
      const childLink = path.join(linkPath, childName)

      let childSkip = false
      try {
        const childStats = await fs.fileLstat(childLink)
        if (childStats.isSymbolicLink() && await fs.readSymlink(childLink) === path.resolve(childTarget)) {
          childSkip = true
        } else {
          // Existing entry (e.g. real file from a previous non-symlink copy)
          // blocks the per-child symlink. Remove it before symlinking.
          sink.log(`[symlink] Removing existing entry at ${childLink} before symlinking.`)
          await fs.remove(childLink)
        }
      } catch {}

      if (!childSkip) {
        await fs.createSymlink(path.resolve(childTarget), childLink)
      }

      newCache.symlinks ??= []
      if (!newCache.symlinks.includes(childLink)) {
        newCache.symlinks.push(childLink)
      }
    }
    return
  }

  // Create symlink
  if (!skip) {
    sink.log(`[symlink] Creating symlink for ${targetPath.replace(`${path.dirname(targetPath)}${path.sep}`, '')}`)
    await fs.createSymlink(path.resolve(targetPath), linkPath)
  }

  // Track in cache
  newCache.symlinks ??= []
  newCache.symlinks.push(linkPath)
}

// Archive creation

export async function createArchive(
  local: sandstone.AfterAllLocal,
  packType: PackType
): Promise<boolean> {
  const input = path.join(local.outputFolder, packType.type)

  const files = await local.fs.readDirNames(input).catch(() => [])
  if (files.length === 0) return false

  const archiveName = `${local.packName}_${packType.type}.zip`
  local.newCache.archives ??= []
  local.newCache.archives.push(archiveName)

  const archive = new AdmZip()
  await archive.addLocalFolderPromise(input, {})
  await local.fs.ensureDir(path.join(local.outputFolder, 'archives'))
  await archive.writeZipPromise(
    path.join(local.outputFolder, 'archives', archiveName),
    { overwrite: true },
  )

  return true
}

// Run pack type's export handler for client/server destinations

export async function runExportHandler(
  local: sandstone.AfterAllLocal,
  packType: PackType,
  target: 'client' | 'server',
  exportPath: string
) {
  if (!packType.handleOutput) return

  await packType.handleOutput(
    target,
    ((relativePath: string, encoding: BufferEncoding = 'utf8') => 
      fs.textFormats.has(encoding)
          ? local.fs.readText(path.join(exportPath, relativePath))
          : local.fs.readBytes(path.join(exportPath, relativePath))
    ),
    async (relativePath: string, contents: any) => {
      if (contents === undefined) {
        await local.fs.unlinkPath(path.join(exportPath, relativePath))
      } else {
        await local.fs.writeText(path.join(exportPath, relativePath), contents)
      }
    },
  )
}

// Export destination helpers

export async function preserveSymlink(
  symlinkPath: string | undefined,
  oldCache: SandstoneCache,
  newCache: SandstoneCache
) {
  if (!getSymlinksAvailable() || !symlinkPath) return
  if (!oldCache.symlinks) return

  const perChildEntries = newCache.perChildEntries?.[symlinkPath]
  if (perChildEntries && (await fs.pathExists(symlinkPath)) && (await fs.fileLstat(symlinkPath)).isDirectory()) {
    const sep = path.sep
    for (const oldSymlink of oldCache.symlinks) {
      if (!oldSymlink.startsWith(symlinkPath + sep)) continue
      const childName = oldSymlink.slice(symlinkPath.length + 1)
      if (childName.includes(sep)) continue
      if (!perChildEntries.includes(childName)) continue
      newCache.symlinks ??= []
      if (!newCache.symlinks.includes(oldSymlink)) {
        newCache.symlinks.push(oldSymlink)
      }
    }
    return
  }

  if (!oldCache.symlinks.includes(symlinkPath)) return

  newCache.symlinks ??= []
  if (!newCache.symlinks.includes(symlinkPath)) {
    newCache.symlinks.push(symlinkPath)
  }
}

export async function exportPack(
  local: sandstone.AfterAllLocal,
  destPath: string,
  sink: LoggerSink,
  packType: PackType,
  archivedOutput: boolean,
  target: 'client' | 'server',
) {
  await local.fs.ensureDir(path.dirname(destPath))

  if (archivedOutput && (local.saveOptions.exportZips ?? packType.archiveOutput)) {
    const archivePath = path.join(local.outputFolder, 'archives', `${local.packName}_${packType.type}.zip`)
    await local.fs.copyFile(archivePath, `${destPath}.zip`)
  } else if (getSymlinksAvailable()) {
    if (!local.oldCache?.symlinks?.includes(destPath)) {
      const allowListRoot = target === 'server' ? local.serverPath! : local.clientPath!
      await createSymlink(local.folder, local.packName, local.newCache!, allowListRoot, path.join(local.outputFolder, packType.type), sink, destPath)
    }
  } else {
    await local.fs.remove(destPath)
    await local.fs.copyDir(path.join(local.outputFolder, packType.type), destPath)
  }
}

export function getExportPath(
  local: sandstone.AfterAllLocal,
  packType: PackType,
  target: 'client' | 'server'
): string {
  if (target === 'server') {
    return path.join(local.serverPath!, packType.serverPath).replace('$packName$', local.packName)
  }
  if (local.worldName && (packType.type !== 'resourcepack' || (local.saveOptions.exportZips ?? packType.archiveOutput))) {
    return path.join(local.clientPath!, packType.clientPath)
      .replace('$packName$', local.packName)
      .replace('$worldName$', local.worldName!)
  }
  return path.join(local.clientPath!, packType.rootPath).replace('$packName$', local.packName)
}

export async function cleanupOldSymlinks(local: sandstone.AfterAllLocal) {
  if (!local.oldCache?.symlinks) return

  const newSymlinks = new Set(local.newCache?.symlinks ?? [])

  for (const symlink of local.oldCache.symlinks) {
    if (!newSymlinks.has(symlink)) {
      await local.fs.unlinkPath(symlink)
    }
  }
}

export async function cleanupOldArchives(local: sandstone.AfterAllLocal) {
  if (!local.oldCache?.archives) return

  const archivesDir = path.join(local.outputFolder, 'archives')
  if (!local.newCache?.archives || local.newCache.archives.length === 0) {
    await local.fs.remove(archivesDir, { recursive: true, force: true })
    return
  }

  for (const archive of local.oldCache!.archives!) {
    if (!local.newCache!.archives!.includes(archive)) {
      await local.fs.remove(path.join(archivesDir, archive))
    }
  }
}
