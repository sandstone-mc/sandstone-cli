import { describe, expect, test } from 'bun:test'

import { dedupeAndDecorate, getAvailableSandstoneVersions } from '../src/commands/versionDiscovery.ts'

describe('dedupeAndDecorate', () => {
  test('parses v-tagged versions and decorates with MC version', () => {
    const out = dedupeAndDecorate(['v1.2.0', 'v1.0.5'], 'gh')
    expect(out).toEqual([
      { major: 1, minor: 2, mcVersion: '26.3', source: 'gh' },
      { major: 1, minor: 0, mcVersion: '26.1', source: 'gh' },
    ])
  })

  test('sorts descending by minor', () => {
    const out = dedupeAndDecorate(['v1.0.0', 'v1.3.0', 'v1.1.0'], 'gh')
    expect(out.map((v) => v.minor)).toEqual([3, 1, 0])
  })

  test('dedupes by minor — patches collapse to one entry', () => {
    const out = dedupeAndDecorate(['v1.0.0', 'v1.0.5', 'v1.0.10', 'v1.2.0'], 'gh')
    expect(out).toHaveLength(2)
    expect(out.map((v) => v.minor)).toEqual([2, 0])
  })

  test('skips tags that do not match the v{X}.{Y}.{Z} shape', () => {
    const out = dedupeAndDecorate(['v1.2.0', 'latest', 'main', 'v2', 'v1.2'], 'gh')
    expect(out.map((v) => v.minor)).toEqual([2])
  })

  test('carries source label through to each entry', () => {
    expect(dedupeAndDecorate(['v1.0.0'], 'fetch-npm')[0]?.source).toBe('fetch-npm')
    expect(dedupeAndDecorate(['v1.0.0'], 'fetch-github')[0]?.source).toBe('fetch-github')
    expect(dedupeAndDecorate(['v1.0.0'], 'fallback')[0]?.source).toBe('fallback')
  })

  test('returns empty list when no tags parse', () => {
    expect(dedupeAndDecorate(['nope', 'also-nope'], 'gh')).toEqual([])
  })
})

describe('getAvailableSandstoneVersions', () => {
  test('returns a non-empty list of maintained versions with a valid source label', async () => {
    const out = await getAvailableSandstoneVersions()
    expect(out.length).toBeGreaterThan(0)

    const validSources = new Set(['gh', 'fetch-github', 'fetch-npm', 'fallback'])
    for (const v of out) {
      expect(validSources.has(v.source)).toBe(true)
      expect(Number.isInteger(v.major)).toBe(true)
      expect(Number.isInteger(v.minor)).toBe(true)
      expect(v.minor).toBeGreaterThanOrEqual(0)
      expect(v.mcVersion).toMatch(/^\d+\.\d+$/)
    }
  })

  test('returns versions sorted by minor desc, then major desc', async () => {
    const out = await getAvailableSandstoneVersions()
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]!
      const cur = out[i]!
      if (prev.minor === cur.minor) {
        expect(prev.major).toBeGreaterThanOrEqual(cur.major)
      } else {
        expect(prev.minor).toBeGreaterThan(cur.minor)
      }
    }
  })

  test('includes all currently maintained minors (1.0, 1.1, 1.2)', async () => {
    const out = await getAvailableSandstoneVersions()
    const minors = new Set(out.map((v) => v.minor))
    expect(minors.has(0)).toBe(true)
    expect(minors.has(1)).toBe(true)
    expect(minors.has(2)).toBe(true)
  })

  test('does not cap minors above the latest published one', async () => {
    // Once 1.3 ships it'll show up here too — there is no bundled-minor cap.
    const out = await getAvailableSandstoneVersions()
    const maxMinor = Math.max(...out.map((v) => v.minor))
    expect(maxMinor).toBeGreaterThanOrEqual(2)
  })

  test('every entry has a unique (major, minor) pair', async () => {
    const out = await getAvailableSandstoneVersions()
    const keys = out.map((v) => `${v.major}.${v.minor}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('filters out pre-1.0 (0.x.y) tags', async () => {
    const out = await getAvailableSandstoneVersions()
    for (const v of out) {
      expect(v.major).toBeGreaterThanOrEqual(1)
    }
  })

  test('only returns versions from maintained dist-tag channels', async () => {
    // Direct registry check: the npm dist-tag filter keeps `latest` and
    // `sandstone-{major}-{minor}` keys only. If the registry ever exposes
    // something like `next` or `legacy`, it must not surface here.
    const res = await fetch('https://registry.npmjs.org/sandstone')
    const data = (await res.json()) as { 'dist-tags': Record<string, string> }
    const distTagKeys = Object.keys(data['dist-tags'])

    const validKey = (k: string) => k === 'latest' || /^sandstone-\d+-\d+$/.test(k)
    expect(distTagKeys.every(validKey)).toBe(true)

    const out = await getAvailableSandstoneVersions()
    const expectedMinors = new Set(
      Object.values(data['dist-tags'])
        .filter((_, i) => validKey(distTagKeys[i]!))
        .map((v) => parseInt(v.split('.')[1]!, 10))
        .filter((n) => Number.isFinite(n)),
    )
    const gotMinors = new Set(out.map((v) => v.minor))
    expect(gotMinors).toEqual(expectedMinors)
  })
})
