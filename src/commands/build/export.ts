import path from 'path'
import os from 'os'
import AdmZip from 'adm-zip'

import { log } from '../../ui/logger.js'
import { canUseSymlinks } from '../../utils/index.js'
import * as fs from '../../utils/fs.js'
import type * as sandstone from 'sandstone'
import type { PackType } from 'sandstone/pack'

export type SandstoneCache = {
  files: Record<string, string>
  archives?: string[]
  canUseSymlinks?: boolean
  symlinks?: string[]
  // For destinations that are themselves existing directories (e.g. the
  // world's pre-existing `datapacks/` folder into which Smithed dependency
  // zips are symlinked individually): per destination path, the names of
  // the children currently generated for that destination by this build.
  // Used by `preserveSymlink` to know which old per-child symlinks are still
  // backed by a current entry, and by `fs.createSymlink` to know which children
  // to (re-)symlink. Keys are absolute/resolved destination paths; values
  // are child basenames. Populated only for destinations that are themselves
  // existing directories, so the field is absent for folder-symlink cases.
  perChildEntries?: Record<string, string[]>
  // The resolved `exportZips` value used for each pack type at build time
  // (`saveOptions.exportZips ?? packType.archiveOutput`). Persisted so that
  // `sand clean` can read the same value back instead of re-deriving it from
  // the pack type's default — which is only known to the core library.
  packTypeExportZips?: Record<string, boolean>
}

// Module-level symlink availability cache
let symlinksAvailable: boolean | undefined

export async function checkSymlinksAvailable(local: sandstone.BeforeSaveLocal): Promise<boolean> {
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

export async function getClientPath(): Promise<string | undefined> {
  const mcPath = getMCPath()

  try {
    await fs.fileLstat(mcPath)
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
  linkPath: string
) {
  // Update allowed_symlinks.txt for Minecraft
  let rawPath = path.resolve(path.join(folder))
  let sep: string = path.sep
  if (process.platform === 'win32') {
    // Minecraft's glob syntax uses `\` as the escape character, so each
    // separator in the workspace path must be doubled.
    sep = `${path.sep}${path.sep}`
    rawPath = rawPath.replaceAll(path.sep, sep)
  }
  const allowPath = `[glob]${rawPath}${sep}**${sep}*`

  const allowedList = path.join(minecraftPath, 'allowed_symlinks.txt')

  const comment = `# Sandstone Pack: ${packName}\n`
  try {
    const currentlyAllowed = (await fs.readText(allowedList)).replace(/\r/g, '')

    // Do not build a RegExp from Minecraft's glob syntax: `**` is invalid
    // regex syntax and would make the catch block overwrite the allowlist.
    if (currentlyAllowed.split('\n').includes(allowPath)) {
      log('[symlink] Workspace already in allowed_symlinks.txt, skipping...')
    } else {
      log('[symlink] Adding workspace to allowed_symlinks.txt. If the game is running please restart it.')
      // Append: Bun.write has no append mode, so concat existing + new entry.
      // Preserve prior comments + glob entries; only add a `#` separator line
      // between them so the new block is visually distinct.
      const separator = currentlyAllowed.length > 0
        ? (currentlyAllowed.endsWith('\n') ? '' : '\n') + '#\n'
        : ''
      await fs.writeText(allowedList, currentlyAllowed + separator + comment + allowPath)
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e

    log('[symlink] Creating allowed_symlinks.txt. If the game is running please restart it.')
    await fs.writeText(allowedList, `${comment}${allowPath}`)
  }

  // Inspect what (if anything) exists at linkPath
  let isExistingDirectory = false
  let skip = false
  let errored = false
  try {
    const stats = await fs.fileLstat(linkPath)
    if (stats.isSymbolicLink() && await fs.readSymlink(linkPath) === path.resolve(targetPath)) {
      log('[symlink] Symlink already created, skipping...')
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
    log(`[symlink] ${linkPath} already exists as a directory; symlinking its children individually.`)
    // Iterate `newCache.perChildEntries[linkPath]` (populated by the build
    // loop from `newCache.files`) rather than readdir(targetPath). The output
    // folder on disk can still hold stale files from previous installs that
    // haven't been garbage-collected yet; perChildEntries is the authoritative
    // list of children the current build wants to expose.
    const perChildEntries = newCache.perChildEntries?.[linkPath]

    if (!perChildEntries || perChildEntries.length === 0) {
      log(`[symlink] No active per-child entries for ${linkPath}; leaving existing directory untouched.`)
      return
    }

    for (const childName of perChildEntries) {
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
          log(`[symlink] Removing existing entry at ${childLink} before symlinking.`)
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
    log(`[symlink] Creating symlink for ${targetPath.replace(`${path.dirname(targetPath)}${path.sep}`, '')}`)
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

  // Per-child case: symlinkPath is an existing directory in the destination
  // (e.g. the world's `datapacks/` folder) and previous builds placed
  // individual child symlinks inside it (e.g. `datapacks/player_motion.zip`).
  // Preserve the children that are still active in this build; orphaned
  // entries (uninstalled deps whose output files are about to be cleaned
  // up) are left for `cleanupOldSymlinks` to unlink.
  //
  // Use lstatSync (not statSync) so a symlink-to-a-directory at symlinkPath
  // is not misidentified as a directory itself; the fallback branch below
  // handles that case (the symlink itself is in oldCache.symlinks).
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
  packType: PackType,
  archivedOutput: boolean,
) {
  // Ensure the destination's parent directory exists. Fresh or lightly-used
  // .minecraft installs may not yet have a global `datapacks/` or
  // `resourcepacks/` folder, which would otherwise cause the copy/symlink
  // below to fail with ENOENT.
  await local.fs.ensureDir(path.dirname(destPath))

  if (archivedOutput && (local.saveOptions.exportZips ?? packType.archiveOutput)) {
    // Copy archive
    const archivePath = path.join(local.outputFolder, 'archives', `${local.packName}_${packType.type}.zip`)
    await local.fs.copyFile(archivePath, `${destPath}.zip`)
  } else if (getSymlinksAvailable()) {
    // Create symlink (only if it doesn't already exist)
    if (!local.oldCache?.symlinks?.includes(destPath)) {
      await createSymlink(local.folder, local.packName, local.newCache!, local.clientPath!, path.join(local.outputFolder, packType.type), destPath)
    }
  } else {
    // Copy files
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

  // Client path: use world path or root path
  const useWorldPath = local.worldName && (packType.type !== 'resourcepack' || (local.saveOptions.exportZips ?? packType.archiveOutput))
  if (useWorldPath) {
    return path.join(local.clientPath!, packType.clientPath)
      .replace('$packName$', local.packName)
      .replace('$worldName$', local.worldName!)
  }
  return path.join(local.clientPath!, packType.rootPath).replace('$packName$', local.packName)
}

// Cleanup

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
