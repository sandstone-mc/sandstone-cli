import path from 'node:path'
import fs from 'fs-extra'

import { DataPackDependencies, ResourcePackDependencies, type PackType } from 'sandstone/pack'

import type { SandstoneCache } from './export.js'
import { hash } from '../../utils.js'

export type FileExclusions = {
  generated: RegExp[] | undefined
  existing: RegExp[] | undefined
} | false

export type FileHandler = {
  path: RegExp
  callback: (contents: string | Buffer | Promise<Buffer>) => Promise<Buffer>
}

async function walk(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)))
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
  folder: string,
  sandstonePack: { packTypes: Map<string, PackType>; resourcePack: () => void; dataPack: () => void }
) {
  const resourcesFolder = path.join(folder, 'resources')

  if (await fs.pathExists(path.join(resourcesFolder, 'resourcepack'))) {
    const files = await fs.readdir(path.join(resourcesFolder, 'resourcepack'))
    if (files.length > 0) {
      sandstonePack.resourcePack()
    }
  }

  if (await fs.pathExists(path.join(resourcesFolder, 'datapack'))) {
    const files = await fs.readdir(path.join(resourcesFolder, 'datapack'))
    if (files.length > 0) {
      sandstonePack.dataPack()
    }
  }

  // Register datapack_dependencies / resourcepack_dependencies pack types when
  // any zips or folders are present under resources/<type>_dependencies/.
  // These pack types export Smithed-style dependency archives alongside the
  // generated pack output.
  const datapackDepsPath = path.join(resourcesFolder, 'datapack_dependencies')
  if (await fs.pathExists(datapackDepsPath)) {
    const entries = await fs.readdir(datapackDepsPath)
    if (entries.length > 0) {
      sandstonePack.packTypes.set('datapack_dependencies', new DataPackDependencies())
    }
  }

  const resourcepackDepsPath = path.join(resourcesFolder, 'resourcepack_dependencies')
  if (await fs.pathExists(resourcepackDepsPath)) {
    const entries = await fs.readdir(resourcepackDepsPath)
    if (entries.length > 0) {
      sandstonePack.packTypes.set('resourcepack_dependencies', new ResourcePackDependencies())
    }
  }
}

/**
 * Process external resources from the resources/ folder.
 */
export async function processExternalResources(
  packType: string,
  folder: string,
  outputFolder: string,
  oldCache: SandstoneCache,
  newCache: SandstoneCache,
  changedPackTypes: Set<string>,
  newDirs: Set<string>,
  fileExclusions: FileExclusions,
  fileHandlers: FileHandler[] | false
) {
  const working = path.join(folder, 'resources', packType)

  if (!(await fs.pathExists(working))) {
    return
  }

  for (const file of await walk(working)) {
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
      let content = await fs.readFile(file)

      // Apply file handlers
      if (fileHandlers) {
        for (const handler of fileHandlers) {
          if (handler.path.test(relativePath)) {
            content = (await handler.callback(content)) as Buffer<ArrayBuffer>
          }
        }
      }

      const hashValue = hash(content + relativePath)

      // If sandstonePack.save() already wrote a file at this path (e.g., a Tag generated it),
      // the cache already holds the generated hash — leave the generated file untouched and
      // don't overwrite it with the resources file content.
      const generatedByPack = relativePath in newCache.files && newCache.files[relativePath] !== hashValue

      if (!generatedByPack) {
        newCache.files[relativePath] = hashValue

        // Track directories
        for (let dir = path.dirname(relativePath); dir && dir !== '.'; dir = path.dirname(dir)) {
          if (newDirs.has(dir)) {
            break
          } else {
            newDirs.add(dir)
          }
        }

        // Write if changed, or if the output file's size differs from the resources file's size.
        // The cache alone can miss stale output when sandstonePack.save() previously wrote merged
        // content to disk but processExternalResources then overwrote the cache entry.
        const realPath = path.join(outputFolder, relativePath)
        let sizeDiffers = false
        try {
          const existingStat = await fs.stat(realPath)
          if (existingStat.size !== content.length) {
            sizeDiffers = true
          }
        } catch {
          // Output file doesn't exist — treat as needing a write
          sizeDiffers = true
        }

        if (oldCache.files[relativePath] !== hashValue || sizeDiffers) {
          changedPackTypes.add(packType)

          await fs.ensureDir(path.dirname(realPath))
          await fs.writeFile(realPath, content)
        }
      }
    } catch {}
  }
}
