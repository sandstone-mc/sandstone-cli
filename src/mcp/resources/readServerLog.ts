/**
 * `sandstone://server-log{?tail,maxLines,from,to,since,until}` — Minecraft
 * server log.
 *
 * Reads from the daemon's in-memory buffer (populated via the host's
 * `attachLog` at daemon boot). Works in pack and library mode — library
 * test workspaces deploy to a server too, and the daemon's buffer is
 * populated regardless of whether a watcher is running.
 *
 * All six query params required; `-1` skips the corresponding filter.
 *
 * Resource URI: `sandstone://server-log{?tail,maxLines,from,to,since,until}`
 * Format: `text/plain`
 */

import { type McpBridge } from '../bridge.js'
import { coerceFileLogParams, formatLogHeader } from '../../utils/logParams.js'

export const URI = 'sandstone://server-log{?tail,maxLines,from,to,since,until}'
export const FIXED_URI = 'sandstone://server-log'
export const MIME = 'text/plain'
export const NAME = 'server-log'
export const DESCRIPTION = 'Minecraft server log, read from the daemon\'s in-memory buffer (populated via the host\'s `attachLog` at daemon boot). All six query params required; pass `-1` to skip a filter.'

export async function read(
  bridge: McpBridge,
  params: { tail: number; maxLines: number; from: number; to: number; since: number; until: number },
): Promise<{ uri: string; mimeType: string; text: string }> {
  return bridge.withDaemon(async (daemon) => {
    const result = await daemon.readServerLog(coerceFileLogParams(params))
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: `${formatLogHeader('Server log', result)}\n\n${result.lines.join('\n')}`,
    }
  })
}