/**
 * `sandstone://client-log{?tail,from,to}` — Minecraft client
 * (launcher) log.
 *
 * Reads through the daemon's intrinsic `readClientLog` RPC, which
 * reads directly from the local Minecraft client's
 * `logs/latest.log` (resolved via `saveConfig.clientPath`). The MCP
 * server never reads the file directly — the daemon owns the launcher
 * log access regardless of which host provider owns the MC server.
 *
 * Query params (all three are REQUIRED on every call). Pass `-1` for
 * the line-ID bounds to skip the range filter.
 *
 * Returns a helpful message when:
 *   - mode is library (no client deploy target),
 *   - `saveConfig.clientPath` is unset (user hasn't configured one).
 *
 * Resource URI: `sandstone://client-log{?tail,from,to}`
 * Format: `text/plain`
 */

import { withDaemon, type McpContext } from '../daemon-client.js'
import { coerceClientLogParams } from '../../utils/logParams.js'

export const URI = 'sandstone://client-log{?tail,from,to}'
export const FIXED_URI = 'sandstone://client-log'
export const MIME = 'text/plain'
export const NAME = 'client-log'
export const DESCRIPTION = 'Minecraft client log, read via the daemon\'s intrinsic `readClientLog` RPC. All three query params required; pass `-1` to skip a filter.'

export async function read(
  ctx: McpContext,
  params: { tail: number; from: number; to: number },
): Promise<{ uri: string; mimeType: string; text: string }> {
  return withDaemon(ctx, async (daemon) => {
    const active = await daemon.getActiveConfig()
    if (active.mode === 'library') {
      return {
        uri: FIXED_URI,
        mimeType: MIME,
        text: 'Not applicable in library mode — libraries don\'t deploy to a Minecraft client.',
      }
    }
    const clientPath = active.saveConfig?.clientPath
    if (!clientPath) {
      return {
        uri: FIXED_URI,
        mimeType: MIME,
        text: '`saveOptions.clientPath` is not set in `sandstone.config.ts`. Set it to a Minecraft installation directory to enable this resource.',
      }
    }
    // Tail / range filtering happens server-side via the RPC params.
    const result = await daemon.readClientLog(coerceClientLogParams(params))
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: result.lines.join('\n'),
    }
  })
}