/**
 * `sandstone://watcher-status` — current state of any `sand watch`
 * process connected to the daemon.
 *
 * Watchers publish their runtime state via `publishWatcherStatus` on
 * connect; the daemon caches the latest snapshot and flips
 * `connected: false` when the watcher's WS session closes.
 *
 * Agent usage:
 *   1. `resources/read sandstone://watcher-status` — check if a watcher
 *      is currently running and what mode (`pack`/`library`) and
 *      whether it's in manual mode (changes queue until the user runs
 *      them vs auto-rebuild on every source change).
 *   2. `resources/subscribe sandstone://watcher-status` — get live push
 *      when the watcher connects/disconnects.
 *
 * Resource URI: `sandstone://watcher-status`
 * Format: `application/toml`
 */

import { formatConfigAsToml, sentinelizeNullish } from '../serialize-config.js'
import { type McpBridge } from '../bridge.js'
import type { WatcherStatus } from '../../commands/connect/rpc.js'

export const URI = 'sandstone://watcher-status'
export const FIXED_URI = URI
export const MIME = 'application/toml'
export const NAME = 'watcher-status'
export const DESCRIPTION = 'Current `sand watch` connection state (connected/mode/manual/path/pid). Subscribe for live connect/disconnect events.'

export async function read(bridge: McpBridge): Promise<{ uri: string; mimeType: string; text: string }> {
  const daemon = await bridge.requireDaemon()
  const result = await daemon.getWatcherStatus()
  const status: WatcherStatus | null = result.status
  const body = sentinelizeNullish(status ?? {
    connected: false,
    mode: null,
    manual: false,
    path: '<no-watcher>',
    pid: 0,
    at: new Date(0).toISOString(),
    note: 'no watcher has connected since the daemon started',
  })
  return {
    uri: FIXED_URI,
    mimeType: MIME,
    text: formatConfigAsToml(body),
  }
}