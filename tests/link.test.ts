import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import {
  buildLibrary,
  cleanupTestRuns,
  findOutputWithMarker,
  harnessCreate,
  join,
  rebuildAndRepackLibrary,
  resetTestRuns,
  runSand,
  spawnWatch,
  walk,
  writeLibraryMarker,
  writePackCaller,
} from './helpers.ts'

// State shared across the suite. Tests run sequentially and each builds
// on the previous (state-machine style).
const libName = '@test-scope/my-lib'
const basename = 'mylib'
let LIB: string
let PACK: string
let hash1 = ''
let hash2 = ''

beforeAll(async () => {
  await resetTestRuns()
})

afterAll(async () => {
  await cleanupTestRuns()
})

describe('create', () => {
  test('library: package.json and test/package.json renamed + bun.lock updated', async () => {
    LIB = await harnessCreate('mylib', true)
    expect(existsSync(join(LIB, 'package.json'))).toBe(true)
    const rootName = JSON.parse(await readFile(join(LIB, 'package.json'), 'utf-8')).name
    expect(rootName).not.toBe('sandstone-template')
    expect(rootName).toBe(libName)
    const testPkg = JSON.parse(await readFile(join(LIB, 'test', 'package.json'), 'utf-8'))
    expect(testPkg.name).toBe(`${libName}-test`)
    expect(testPkg.dependencies?.[libName]).toBe(`link:${libName}`)
    // bun.lock must be rewritten to the new name (the template ships a
    // pre-built lockfile; without rewriting it, the `link:<name>` entry
    // points at the old name and the workspace install fails to resolve
    // for scoped packages).
    const lock = await readFile(join(LIB, 'bun.lock'), 'utf-8')
    expect(lock).not.toContain('sandstone-template')
    expect(lock).toContain(libName)
  }, 30_000)

  test('library: test/ workspace installs and resolves the link', async () => {
    const testDir = join(LIB, 'test')
    const proc = Bun.spawn({
      cmd: ['bun', 'install'],
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(
      exitCode,
      `bun install failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    ).toBe(0)
    expect(existsSync(join(testDir, 'node_modules', libName))).toBe(true)
  }, 30_000)

  test('pack: package.json created via harness', async () => {
    PACK = await harnessCreate('mypack', false)
    expect(existsSync(join(PACK, 'package.json'))).toBe(true)
  }, 30_000)
})

describe('link', () => {
  test('library: sand link produces tarball and link_version', async () => {
    const r = await runSand(['link'], LIB)
    expect(r.exitCode).toBe(0)
    expect(existsSync(join(LIB, '.sandstone', `${basename}.tgz`))).toBe(true)
    expect(existsSync(join(LIB, '.sandstone', 'link_version'))).toBe(true)
    hash1 = (await readFile(join(LIB, '.sandstone', 'link_version'), 'utf-8')).trim()
    expect(hash1.length).toBeGreaterThan(0)
  })

  test('consumer: sand link installs and records hash', async () => {
    const r = await runSand(['link', LIB], PACK)
    expect(r.exitCode).toBe(0)
    expect(existsSync(join(PACK, '.sandstone', 'links.json'))).toBe(true)
    expect(existsSync(join(PACK, 'node_modules', libName))).toBe(true)
    const packPkg = JSON.parse(await readFile(join(PACK, 'package.json'), 'utf-8'))
    expect(packPkg.dependencies?.[libName] ?? packPkg.devDependencies?.[libName]).toBeTruthy()
    const linksData = JSON.parse(await readFile(join(PACK, '.sandstone', 'links.json'), 'utf-8'))
    expect(linksData.links[libName]?.currentHash).toBe(hash1)
  })

  test('idempotency: re-running sand link is a no-op', async () => {
    const r = await runSand(['link', LIB], PACK)
    expect(r.exitCode).toBe(0)
  })
})

describe('build sync', () => {
  test('library: edit + re-pack bumps the hash', async () => {
    const libIndex = join(LIB, 'src', 'index.ts')
    expect(existsSync(libIndex)).toBe(true)
    const original = await readFile(libIndex, 'utf-8')
    await writeFile(libIndex, original + `\n// touched at ${Date.now()}\n`)
    const r = await runSand(['link'], LIB)
    expect(r.exitCode).toBe(0)
    hash2 = (await readFile(join(LIB, '.sandstone', 'link_version'), 'utf-8')).trim()
    expect(hash2).not.toBe(hash1)
  })

  test('consumer: sand build auto-syncs the new hash and reinstalls', async () => {
    const before = JSON.parse(await readFile(join(PACK, '.sandstone', 'links.json'), 'utf-8'))
    expect(before.links[libName]?.currentHash).toBe(hash1)
    await runSand(['build'], PACK)
    expect(existsSync(join(PACK, 'node_modules', libName))).toBe(true)
    const after = JSON.parse(await readFile(join(PACK, '.sandstone', 'links.json'), 'utf-8'))
    expect(after.links[libName]?.currentHash).toBe(hash2)
  })

  test('library code change flows through to pack output', async () => {
    const MARKER_A = `LINK_MARKER_ALPHA_${Date.now()}`
    const MARKER_B = `LINK_MARKER_BRAVO_${Date.now()}`

    await writeLibraryMarker(LIB, libName, MARKER_A)
    await writePackCaller(PACK, libName)
    await rebuildAndRepackLibrary(LIB)
    await runSand(['build'], PACK)

    const outFile = await findOutputWithMarker(join(PACK, '.sandstone', 'output'), MARKER_A)
    expect(outFile).not.toBeNull()
    const out = await readFile(outFile!, 'utf-8')
    expect(out).toContain(MARKER_A)
    expect(out).not.toContain(MARKER_B)

    // Swap to B → A must disappear everywhere.
    await writeLibraryMarker(LIB, libName, MARKER_B)
    await rebuildAndRepackLibrary(LIB)
    await runSand(['build'], PACK)
    const outBFile = await findOutputWithMarker(join(PACK, '.sandstone', 'output'), MARKER_B)
    expect(outBFile).not.toBeNull()
    const outB = await readFile(outBFile!, 'utf-8')
    expect(outB).toContain(MARKER_B)
    const all = await walk(join(PACK, '.sandstone', 'output'), (p) => p.endsWith('.mcfunction'))
    for (const f of all) {
      expect(await readFile(f, 'utf-8')).not.toContain(MARKER_A)
    }
  })
})

describe('watch live sync', () => {
  test('sand watch --library + sand watch round-trip a marker change', async () => {
    const LIVE_MARKER = `LIVE_MARKER_${Date.now()}`
    await writeLibraryMarker(LIB, libName, LIVE_MARKER)
    await writePackCaller(PACK, libName)
    await buildLibrary(LIB)
    await runSand(['link'], LIB)
    await runSand(['link', LIB], PACK)

    const libWatch = spawnWatch(['watch', '--library'], LIB)
    const packWatch = spawnWatch(['watch'], PACK)
    await Bun.sleep(4_000)

    const LIVE_MARKER_2 = `LIVE_MARKER_2_${Date.now()}`
    await writeLibraryMarker(LIB, libName, LIVE_MARKER_2)

    let found = false
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(1_000)
      const f = await findOutputWithMarker(join(PACK, '.sandstone', 'output'), LIVE_MARKER_2)
      if (f) { found = true; break }
    }

    libWatch.kill()
    packWatch.kill()
    await libWatch.exited.catch(() => {})
    await packWatch.exited.catch(() => {})

    expect(found).toBe(true)
  }, 60_000)
})

describe('unlink', () => {
  test('consumer: unlink removes package and links.json entry', async () => {
    const r = await runSand(['unlink', libName], PACK)
    expect(r.exitCode).toBe(0)
    expect(existsSync(join(PACK, 'node_modules', libName))).toBe(false)
    const after = JSON.parse(await readFile(join(PACK, '.sandstone', 'links.json'), 'utf-8'))
    expect(after.links[libName]).toBeUndefined()
  })

  test('library: sand unlink removes tarball and link_version', async () => {
    const r = await runSand(['unlink'], LIB)
    expect(r.exitCode).toBe(0)
    expect(existsSync(join(LIB, '.sandstone', `${basename}.tgz`))).toBe(false)
    expect(existsSync(join(LIB, '.sandstone', 'link_version'))).toBe(false)
  })
})