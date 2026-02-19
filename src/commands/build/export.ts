import path from 'node:path'
import os from 'node:os'
import fs from 'fs-extra'
import AdmZip from 'adm-zip'

import { log } from '../../ui/logger.js'
import { canUseSymlinks } from '../../utils.js'

import type { handlerReadFile, PackType } from 'sandstone/pack'

export type SandstoneCache = {
  files: Record<string, string>
  archives?: string[]
  canUseSymlinks?: boolean
  symlinks?: string[]
}

// Module-level symlink availability cache
let symlinksAvailable: boolean | undefined

export async function checkSymlinksAvailable(cachedValue?: boolean): Promise<boolean> {
  if (symlinksAvailable === undefined) {
    if (cachedValue !== undefined) {
      symlinksAvailable = cachedValue
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

export async function getClientPath(): Promise<string | undefined> {
  const mcPath = getMCPath()

  try {
    await fs.stat(mcPath)
  } catch {
    log('Unable to locate the .minecraft folder. Will not be able to export to client.')
    return undefined
  }

  return mcPath
}

export async function getClientWorldPath(worldName: string, minecraftPath?: string): Promise<string> {
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

// Symlink handling

export async function createSymlink(
  folder: string,
  packName: string,
  newCache: SandstoneCache,
  minecraftPath: string,
  targetPath: string,
  linkPath: string
) {
  // Update allowed_symlinks.txt for Minecraft
  let rawPath = path.resolve(path.join(folder))
  let sep: string = path.sep
  if (os.platform() === 'win32') {
    sep = `${path.sep}${path.sep}`
    rawPath = rawPath.replace(path.sep, sep)
  }
  const allowPath = `[glob]${rawPath}${sep}**${sep}*`

  const allowedList = path.join(minecraftPath, 'allowed_symlinks.txt')

  const comment = `# Sandstone Pack: ${packName}\n`
  try {
    const currentlyAllowed = await fs.readFile(allowedList, 'utf-8')

    if (!currentlyAllowed.includes(allowPath)) {
      log('[symlink] Adding workspace to allowed_symlinks.txt. If the game is running please restart it.')
      await fs.writeFile(allowedList, `${currentlyAllowed}\n#\n${comment}${allowPath}`)
    } else {
      log('[symlink] Workspace already in allowed_symlinks.txt, skipping...')
    }
  } catch (e) {
    log('[symlink] Creating allowed_symlinks.txt. If the game is running please restart it.')
    await fs.writeFile(allowedList, `${comment}${allowPath}`)
  }

  // Check if symlink already exists
  let skip = false
  let errored = false
  try {
    const stats = await fs.lstat(linkPath)
    if (stats.isSymbolicLink() && await fs.readlink(linkPath) === path.resolve(targetPath)) {
      log('[symlink] Symlink already created, skipping...')
      skip = true
    } else {
      errored = true
    }
  } catch {}

  if (errored) {
    throw new Error(`Tried to add a symlink at "${linkPath}",\n encountered an existing FS entry.`)
  }

  // Create symlink
  if (!skip) {
    log(`[symlink] Creating symlink for ${targetPath.replace(`${path.dirname(targetPath)}${path.sep}`, '')}`)
    await fs.symlink(path.resolve(targetPath), linkPath)
  }

  // Track in cache
  newCache.symlinks ??= []
  newCache.symlinks.push(linkPath)
}

// Archive creation

export async function createArchive(
  outputFolder: string,
  packName: string,
  packType: PackType,
  newCache: SandstoneCache
): Promise<boolean> {
  const input = path.join(outputFolder, packType.type)

  const files = await fs.readdir(input).catch(() => [])
  if (files.length === 0) return false

  const archiveName = `${packName}_${packType.type}.zip`
  newCache.archives ??= []
  newCache.archives.push(archiveName)

  const archive = new AdmZip()
  await archive.addLocalFolderPromise(input, {})
  await fs.ensureDir(path.join(outputFolder, 'archives'))
  await archive.writeZipPromise(
    path.join(outputFolder, 'archives', archiveName),
    { overwrite: true },
  )

  return true
}

// Run pack type's export handler for client/server destinations

export async function runExportHandler(
  packType: PackType,
  target: 'client' | 'server',
  exportPath: string
) {
  if (!packType.handleOutput) return

  await packType.handleOutput(
    target,
    (async (relativePath: string, encoding: BufferEncoding = 'utf8') =>
      await fs.readFile(path.join(exportPath, relativePath), encoding)) as unknown as handlerReadFile,
    async (relativePath: string, contents: any) => {
      if (contents === undefined) {
        await fs.unlink(path.join(exportPath, relativePath))
      } else {
        await fs.writeFile(path.join(exportPath, relativePath), contents)
      }
    },
  )
}

// Export destination helpers

export function preserveSymlink(
  symlinkPath: string | undefined,
  oldCache: SandstoneCache,
  newCache: SandstoneCache
) {
  if (!getSymlinksAvailable() || !symlinkPath) return
  if (!oldCache.symlinks?.includes(symlinkPath)) return

  newCache.symlinks ??= []
  if (!newCache.symlinks.includes(symlinkPath)) {
    newCache.symlinks.push(symlinkPath)
  }
}

export async function exportPack(
  destPath: string,
  minecraftPath: string,
  outputPath: string,
  outputFolder: string,
  folder: string,
  packName: string,
  packType: PackType,
  archivedOutput: boolean,
  exportZips: boolean | undefined,
  oldCache: SandstoneCache,
  newCache: SandstoneCache
) {
  if (packType.archiveOutput && archivedOutput && exportZips) {
    // Copy archive
    const archivePath = path.join(outputFolder, 'archives', `${packName}_${packType.type}.zip`)
    await fs.copyFile(archivePath, `${destPath}.zip`)
  } else if (getSymlinksAvailable()) {
    // Create symlink (only if it doesn't already exist)
    if (!oldCache.symlinks?.includes(destPath)) {
      await createSymlink(folder, packName, newCache, minecraftPath, outputPath, destPath)
    }
  } else {
    // Copy files
    await fs.remove(destPath)
    await fs.copy(outputPath, destPath)
  }
}

export function getExportPath(
  packType: PackType,
  basePath: string,
  target: 'client' | 'server',
  packName: string,
  worldName: string | undefined,
  exportZips: boolean | undefined
): string {
  if (target === 'server') {
    return path.join(basePath, packType.serverPath).replace('$packName$', packName)
  }

  // Client path: use world path or root path
  const useWorldPath = worldName && (packType.type !== 'resourcepack' || exportZips)
  if (useWorldPath) {
    return path.join(basePath, packType.clientPath)
      .replace('$packName$', packName)
      .replace('$worldName$', worldName)
  }
  return path.join(basePath, packType.rootPath).replace('$packName$', packName)
}

// Cleanup

export async function cleanupOldSymlinks(oldCache: SandstoneCache, newCache: SandstoneCache) {
  if (!oldCache.symlinks) return

  const newSymlinks = new Set(newCache.symlinks)

  for (const symlink of oldCache.symlinks) {
    if (!newSymlinks.has(symlink)) {
      await fs.unlink(symlink)
    }
  }
}

export async function cleanupOldArchives(
  outputFolder: string,
  oldCache: SandstoneCache,
  newCache: SandstoneCache
) {
  if (!oldCache.archives) return

  const archivesDir = path.join(outputFolder, 'archives')
  if (!newCache.archives || newCache.archives.length === 0) {
    await fs.rm(archivesDir, { force: true, recursive: true })
    return
  }

  for (const archive of oldCache.archives) {
    if (!newCache.archives.includes(archive)) {
      await fs.rm(path.join(archivesDir, archive))
    }
  }
}
