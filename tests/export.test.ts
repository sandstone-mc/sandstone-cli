import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { CLI } from './helpers.ts'
import { createSymlink } from '../src/commands/build/export.ts'
import { logger } from '../src/utils/logger.ts'

const root = path.join(CLI, '.temp', `export-allowlist-${process.pid}`)

beforeEach(async () => {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('allowed_symlinks.txt', () => {
  test('preserves existing workspace entries when adding glob path', async () => {
    const oldFolder = path.join(root, 'styd', 'test')
    const folder = path.join(root, 'sandstone-test', 'test')
    const minecraftPath = path.join(root, 'minecraft')
    const targetPath = path.join(folder, '.sandstone', 'output', 'datapack')
    const linkPath = path.join(root, 'world', 'datapacks', 'sandstone-test')
    const oldAllowPath = `[glob]${path.resolve(oldFolder)}${path.sep}**${path.sep}*`

    await mkdir(targetPath, { recursive: true })
    await mkdir(path.dirname(linkPath), { recursive: true })
    await mkdir(minecraftPath, { recursive: true })
    await writeFile(
      path.join(minecraftPath, 'allowed_symlinks.txt'),
      `# Sandstone Pack: styd\n${oldAllowPath}`,
    )

    // `logger.sinks[name]` proxies to a fresh `LoggerSink` handle on
    // first access — same plumbing the CLI uses, so `createSymlink`'s
    // `sink.log(...)` calls land on the real logger. Avoids a hand-
    // rolled stub that would drift from the interface.
    const sink = logger.sinks['test-export']
    await createSymlink(
      folder,
      'sandstone-test-testing',
      { files: {} },
      minecraftPath,
      targetPath,
      sink,
      linkPath,
    )

    const allowlist = await readFile(
      path.join(minecraftPath, 'allowed_symlinks.txt'),
      'utf8',
    )
    const newAllowPath = `[glob]${path.resolve(folder)}${path.sep}**${path.sep}*`

    expect(allowlist).toContain(oldAllowPath)
    expect(allowlist).toContain(newAllowPath)
  })
})
