import { formatConfigAsToml, sentinelizeNullish } from '../serialize-config.js'
import { type McpBridge } from '../bridge.js'
import type { TestState } from '../../commands/connect/rpc.js'

export const URI = 'sandstone://test-state'
export const FIXED_URI = URI
export const MIME = 'application/toml'
export const NAME = 'test-state'
export const DESCRIPTION = 'Current test-run state pushed by the watcher via `publishTestComplete`. Transitions `started → complete | failed | cancelled` and carries `pass`, `fail`, and `durationSec`. Updated automatically when a build with `testingMode: true` (see `sandstone://rebuild-state`) finishes reloading the daemon.'

export async function read(bridge: McpBridge): Promise<{ uri: string; mimeType: string; text: string }> {
  const daemon = await bridge.requireDaemon()
  const result = await daemon.getTestState()
  const state: TestState | null = result.state
  const body = sentinelizeNullish({
    ...(state ?? { state: 'none', note: 'no watcher has pushed a test state yet' as const }),
  })
  return {
    uri: FIXED_URI,
    mimeType: MIME,
    text: formatConfigAsToml(body),
  }
}