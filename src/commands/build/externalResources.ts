import path from 'path'

import { DataPackDependencies, ResourcePackDependencies, type PackType } from 'sandstone/pack'
import type * as sandstone from 'sandstone'

import type { SandstoneCache } from './export.js'
import { hash } from '../../utils/index.js'
import type { FileExclusions, FileHandler } from 'sandstone'

export type { FileExclusions, FileHandler }

async function walk(local: sandstone.BeforeSaveLocal, dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await local.fs.readDirNames(dir)
  // A `withFileTypes: true` readdir returns Dirent; since we use `fs.readDirNames`
  // (plain string list) to avoid the fs-extra-style surface area, do a
  // parallel stat pass for the directory-vs-file distinction. Cheap because
  // resources/ trees are small.
  const annotated = await Promise.all(entries.map(async (name) => {
    try {
      const s = await local.fs.fileStat(path.join(dir, name))
      return { name, isDir: s.isDirectory() }
    } catch {
      return { name, isDir: false }
    }
  }))
  for (const { name, isDir } of annotated) {
    const fullPath = path.join(dir, name)
    if (isDir) {
      files.push(...(await walk(local, fullPath)))
    } else {
      files.push(fullPath)
    }
  }
  return files
}

/**
 * Check if external resources exist and register pack types accordingly.
 */
export async function autoRegisterPackTypes(
  local: sandstone.BeforeSaveLocal,
) {
  const resourcesFolder = path.join(local.folder, 'resources')

  if (await local.fs.pathExists(path.join(resourcesFolder, 'resourcepack'))) {
    const files = await local.fs.readDirNames(path.join(resourcesFolder, 'resourcepack'))
    if (files.length > 0) {
      local.sandstonePack.resourcePack()
    }
  }

  if (await local.fs.pathExists(path.join(resourcesFolder, 'datapack'))) {
    const files = await local.fs.readDirNames(path.join(resourcesFolder, 'datapack'))
    if (files.length > 0) {
      local.sandstonePack.dataPack()
    }
  }

  // Register datapack_dependencies / resourcepack_dependencies pack types when
  // any zips or folders are present under resources/<type>_dependencies/.
  // These pack types export Smithed-style dependency archives alongside the
  // generated pack output.
  const datapackDepsPath = path.join(resourcesFolder, 'datapack_dependencies')
  if (await local.fs.pathExists(datapackDepsPath)) {
    const entries = await local.fs.readDirNames(datapackDepsPath)
    if (entries.length > 0) {
      local.sandstonePack.packTypes.set('datapack_dependencies', new DataPackDependencies())
    }
  }

  const resourcepackDepsPath = path.join(resourcesFolder, 'resourcepack_dependencies')
  if (await local.fs.pathExists(resourcepackDepsPath)) {
    const entries = await local.fs.readDirNames(resourcepackDepsPath)
    if (entries.length > 0) {
      local.sandstonePack.packTypes.set('resourcepack_dependencies', new ResourcePackDependencies())
    }
  }
}

/**
 * Process external resources from the resources/ folder.
 */
export async function processExternalResources(
  local: sandstone.BeforeSaveLocal,
  packType: string,
  fileExclusions: FileExclusions,
  fileHandlers: FileHandler[] | false
) {
  const working = path.join(local.folder, 'resources', packType)

  const encoder = new TextEncoder()

  if (!(await local.fs.pathExists(working))) {
    return
  }

  for (const file of await walk(local, working)) {
    const relativePath = path.join(packType, file.substring(working.length + 1))

    // Check exclusions
    let pathPass = true
    if (fileExclusions && fileExclusions.existing) {
      for (const exclude of fileExclusions.existing) {
        pathPass = Array.isArray(exclude) ? !exclude[0].test(relativePath) : !exclude.test(relativePath)
      }
    }

    if (!pathPass) continue

    try {
      let content: Buffer = await local.fs.readBytes(file)

      // Apply file handlers
      if (fileHandlers) {
        for (const handler of fileHandlers) {
          if (handler.path.test(relativePath)) {
            const possiblyString = await handler.callback(content)
            content = typeof possiblyString === 'string' ? Buffer.from(encoder.encode(possiblyString)) : content
          }
        }
      }

      const hashValue = hash(content + relativePath)

      // If sandstonePack.save() already wrote a file at this path (e.g., a Tag generated it),
      // the cache already holds the generated hash — leave the generated file untouched and
      // don't overwrite it with the resources file content.
      const generatedByPack = relativePath in local.newCache!.files && local.newCache!.files[relativePath] !== hashValue

      if (!generatedByPack) {
        local.newCache!.files[relativePath] = hashValue

        // Track directories
        for (let dir = path.dirname(relativePath); dir && dir !== '.'; dir = path.dirname(dir)) {
          if (local.newDirs!.has(dir)) {
            break
          } else {
            local.newDirs!.add(dir)
          }
        }

        // Write if changed, or if the output file's size differs from the resources file's size.
        // The cache alone can miss stale output when sandstonePack.save() previously wrote merged
        // content to disk but processExternalResources then overwrote the cache entry.
        const realPath = path.join(local.outputFolder, relativePath)
        let sizeDiffers = false
        try {
          const existingStat = await local.fs.fileStat(realPath)
          if (existingStat.size !== content.byteLength) {
            sizeDiffers = true
          }
        } catch {
          // Output file doesn't exist — treat as needing a write
          sizeDiffers = true
        }

        if (local.oldCache!.files[relativePath] !== hashValue || sizeDiffers) {
          local.changedPackTypes!.add(packType)

          await local.fs.ensureDir(path.dirname(realPath))
          await local.fs.writeBytes(realPath, content)
        }
      }
    } catch {}
  }
}
