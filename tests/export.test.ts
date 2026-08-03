import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs-extra'
import path from 'node:path'

import { CLI } from './helpers.ts'
import { checkSymlinksAvailable, createSymlink } from '../src/commands/build/export.ts'

const root = path.join(CLI, '.temp', `export-allowlist-${process.pid}`)

beforeEach(async () => {
  await fs.remove(root)
  await fs.ensureDir(root)
  await checkSymlinksAvailable(true)
})

afterAll(async () => {
  await fs.remove(root)
})

describe('allowed_symlinks.txt', () => {
  test('preserves existing workspace entries when adding glob path', async () => {
    const oldFolder = path.join(root, 'styd', 'test')
    const folder = path.join(root, 'sandstone-test', 'test')
    const minecraftPath = path.join(root, 'minecraft')
    const targetPath = path.join(folder, '.sandstone', 'output', 'datapack')
    const linkPath = path.join(root, 'world', 'datapacks', 'sandstone-test')
    const oldAllowPath = `[glob]${path.resolve(oldFolder)}${path.sep}**${path.sep}*`

    await fs.ensureDir(targetPath)
    await fs.ensureDir(path.dirname(linkPath))
    await fs.ensureDir(minecraftPath)
    await fs.writeFile(
      path.join(minecraftPath, 'allowed_symlinks.txt'),
      `# Sandstone Pack: styd\n${oldAllowPath}`,
    )

    await createSymlink(
      folder,
      'sandstone-test-testing',
      { files: {} },
      minecraftPath,
      targetPath,
      linkPath,
    )

    const allowlist = await fs.readFile(
      path.join(minecraftPath, 'allowed_symlinks.txt'),
      'utf8',
    )
    const newAllowPath = `[glob]${path.resolve(folder)}${path.sep}**${path.sep}*`

    expect(allowlist).toContain(oldAllowPath)
    expect(allowlist).toContain(newAllowPath)
  })
})
