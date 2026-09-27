/**
 * `sandstone://rebuild-state` — current build state the watcher pushed.
 *
 * Watchers call `publishRebuild` at start (`state: 'started'`) and at
 * completion (`'complete'` or `'failed'`). The daemon caches the latest
 * snapshot and fires `notifications/resources/updated` so subscribed
 * MCP clients see start/finish events in real time without polling.
 *
 * Agent usage:
 *   1. `resources/subscribe sandstone://rebuild-state` — get live push
 *   2. On `notifications/resources/updated`, read the resource:
 *      `state: 'complete'` → fetch `build-output` tree + read the log
 *      `state: 'failed'` → read the log for the failure detail
 *      `state: 'started'` → ignore (or show a "rebuilding" indicator)
 *
 * Resource URI: `sandstone://rebuild-state`
 * Format: `application/toml`
 */

import { formatConfigAsToml, sentinelizeNullish } from '../serialize-config.js'
import { requireDaemon, type McpContext } from '../daemon-client.js'
import type { RebuildState } from '../../commands/connect/rpc.js'

export const URI = 'sandstone://rebuild-state'
export const FIXED_URI = URI
export const MIME = 'application/toml'
export const NAME = 'rebuild-state'
export const DESCRIPTION = 'Current build state pushed by the watcher via `publishRebuild`. Subscribe to receive live start/finish events.'

export async function read(ctx: McpContext): Promise<{ uri: string; mimeType: string; text: string }> {
  const daemon = await requireDaemon(ctx.projectRoot)
  const result = await daemon.getRebuildState()
  const state: RebuildState | null = result.state
  const body = sentinelizeNullish(state ?? { state: 'none', note: 'no watcher has pushed a build state yet' })
  return {
    uri: FIXED_URI,
    mimeType: MIME,
    text: formatConfigAsToml(body),
  }
}