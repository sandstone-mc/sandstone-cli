import path from 'path'
import { pathToFileURL } from 'url'
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
    return undefined
  }

  const cfg = mod.default
  if (!cfg || typeof cfg !== 'object') return undefined
  return cfg as sandstone.SandstoneConfig
}
