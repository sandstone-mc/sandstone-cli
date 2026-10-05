import { formatConfigAsToml, sentinelizeNullish } from '../serialize-config.js'
import { type McpBridge } from '../bridge.js'
import type { RebuildState } from '../../commands/connect/rpc.js'

export const URI = 'sandstone://rebuild-state'
export const FIXED_URI = URI
export const MIME = 'application/toml'
export const NAME = 'rebuild-state'
export const DESCRIPTION = 'Current build state pushed by the watcher via `publishRebuild`. Subscribe to receive live start/finish events.'

export async function read(bridge: McpBridge): Promise<{ uri: string; mimeType: string; text: string }> {
  const daemon = await bridge.requireDaemon()
  const [stateResult, statusResult] = await Promise.all([
    daemon.getRebuildState(),
    daemon.getWatcherStatus(),
  ])
  const state: RebuildState | null = stateResult.state
  const testingMode = statusResult.status?.testingMode === true
  const body = sentinelizeNullish({
    ...(state ?? { state: 'none', note: 'no watcher has pushed a build state yet' as const }),
    ...(testingMode ? { testingMode: true, note: 'watcher is in tests-mode — every build runs `sand test` after the daemon reloads' as const } : {}),
  })
  return {
    uri: FIXED_URI,
    mimeType: MIME,
    text: formatConfigAsToml(body),
  }
}