/**
 * `sandstone://save-config` — the live `sandstone.config.ts` snapshot.
 *
 * The watcher is the source of truth at runtime; the daemon caches
 * the latest snapshot it received (via `publishConfig`) and answers
 * `getActiveConfig`. When no watcher has published yet, the daemon
 * returns its boot-time load from disk.
 *
 * Content is TOML (Bun.TOML.stringify via serialize-config helpers).
 * Null/undefined entries become `"<%null%>"` / `"<%undefined%>"`
 * sentinels so the LLM sees structure-preserving placeholders instead
 * of silent drops or throws.
 *
 * Resource URI: `sandstone://save-config`
 * Format: `application/toml`
 */

import { formatConfigAsToml } from '../serialize-config.js'
import { type McpBridge } from '../bridge.js'

export const URI = 'sandstone://save-config'
export const MIME = 'application/toml'
export const NAME = 'save-config'
export const DESCRIPTION =
  'The live `sandstone.config.ts` snapshot the watcher published to the `sand connect` daemon. Falls back to the daemon\'s boot-time disk load when no watcher is running.'

export async function read(bridge: McpBridge): Promise<{ uri: string; mimeType: string; text: string }> {
  const daemon = await bridge.requireDaemon()
  const active = await daemon.getActiveConfig()
  return {
    uri: URI,
    mimeType: MIME,
    text: formatConfigAsToml({
      mode: active.mode,
      configPath: active.configPath,
      saveConfig: active.saveConfig,
    }),
  }
}