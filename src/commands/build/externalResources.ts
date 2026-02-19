import path from 'node:path'
import fs from 'fs-extra'

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
  sandstonePack: { resourcePack: () => void; dataPack: () => void }
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
      newCache.files[relativePath] = hashValue

      // Track directories
      for (let dir = path.dirname(relativePath); dir && dir !== '.'; dir = path.dirname(dir)) {
        if (newDirs.has(dir)) {
          break
        } else {
          newDirs.add(dir)
        }
      }

      // Write if changed
      if (oldCache.files[relativePath] !== hashValue) {
        changedPackTypes.add(packType)

        const realPath = path.join(outputFolder, relativePath)
        await fs.ensureDir(path.dirname(realPath))
        await fs.writeFile(realPath, content)
      }
    } catch {}
  }
}
