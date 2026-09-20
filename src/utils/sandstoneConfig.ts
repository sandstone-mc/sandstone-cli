/**
 * Auto-load the user's `sandstone.config.ts` from a project directory.
 *
 * `sand connect` and `sand run` invoke this on the cwd (or the
 * `--path`) so every host gets the full config — pack name, save
 * options, resources, etc. — without each caller having to wire it
 * itself.
 *
 * Returns `undefined` when:
 *  - no `sandstone.config.ts` exists at `cwd`,
 *  - the file exists but throws on import (treated as "no config"; the
 *    CLI surfaces the real error elsewhere if the user expected one),
 *  - the loaded module has no default export.
 *
 * The import path uses a `file://` URL because dynamic `import()` of
 * relative paths requires URL syntax under ESM, and the CLI bundles
 * for `--target=bun` so the TS file is consumed directly.
 */

import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type * as sandstone from 'sandstone'

export async function loadSandstoneConfig(cwd: string): Promise<sandstone.SandstoneConfig | undefined> {
  const configPath = path.join(cwd, 'sandstone.config.ts')
  let configUrl: string
  try {
    configUrl = pathToFileURL(configPath).toString()
  } catch {
    return undefined
  }

  let mod: { default?: unknown }
  try {
    mod = await import(configUrl)
  } catch {
    // File missing, parse error, or runtime error in the config itself.
    // Surface absence silently; let the user-facing call sites decide
    // whether the missing config is fatal.
    return undefined
  }

  const cfg = mod.default
  if (!cfg || typeof cfg !== 'object') return undefined
  return cfg as sandstone.SandstoneConfig
}
