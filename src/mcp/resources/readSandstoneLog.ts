/**
 * `sandstone://build-log{?tail,maxLines,from,to,since,until}` — the
 * watcher's log buffer (pushed over WS via `publishLog`).
 *
 * Query params (all six are REQUIRED on every call — MCP SDK 1.30.1's
 * form-style `{?var}` matching fails if any declared var is missing).
 * Pass `-1` for any filter you don't want. Range + time filters
 * intersect.
 *
 * Resource URI: `sandstone://build-log{?tail,maxLines,from,to,since,until}`
 * Format: `text/plain`
 */

import { withDaemon, type McpContext } from '../daemon-client.js'
import { coerceFileLogParams, formatLogHeader } from '../../utils/logParams.js'

export const URI = 'sandstone://build-log{?tail,maxLines,from,to,since,until}'
export const FIXED_URI = 'sandstone://build-log'
export const MIME = 'text/plain'
export const NAME = 'sandstone-log'
export const DESCRIPTION = 'Watcher log buffer (pushed via `publishLog`). All six query params required; pass `-1` to skip a filter.'

export async function read(
  ctx: McpContext,
  params: { tail: number; maxLines: number; from: number; to: number; since: number; until: number },
): Promise<{ uri: string; mimeType: string; text: string }> {
  return withDaemon(ctx, async (daemon) => {
    const result = await daemon.readBuildLog(coerceFileLogParams(params))
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: `${formatLogHeader('Watcher log', result)}\n\n${result.lines.join('\n')}`,
    }
  })
}