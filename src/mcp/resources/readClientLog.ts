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
 * the line-ID bounds to skip the range filter:
 *   - `tail=N`       — last N lines. `-1` = use default (200).
 *   - `from=N`       — lower line-ID bound (inclusive). `0` = most
 *                     recent line. `-1` = no range filter.
 *   - `to=N`         — upper line-ID bound (inclusive). `-1` = no
 *                     range filter.
 *
 * Returns a helpful message when:
 *   - mode is library (no client deploy target),
 *   - `saveConfig.clientPath` is unset (user hasn't configured one).
 *
 * Resource URI: `sandstone://client-log{?tail,from,to}`
 * Format: `text/plain`
 */

import { requireDaemon, type McpContext } from '../daemon-client.js'

export const URI = 'sandstone://client-log{?tail,from,to}'
export const FIXED_URI = 'sandstone://client-log'
export const MIME = 'text/plain'
export const NAME = 'client-log'
export const DESCRIPTION = 'Minecraft client log, read via the daemon\'s intrinsic `readClientLog` RPC. All three query params required; pass `-1` to skip a filter.'

/**
 * Apply tail / line ID range to a line array. `0` is the most recent
 * (last) line; line IDs are non-negative. `-1` sentinel means
 * "don't apply this filter". Returns the post-filter slice (still in
 * original order — newest at the end).
 */
export function applyLogRange(
  lines: string[],
  params: { tail: number; from: number; to: number },
): string[] {
  const len = lines.length
  if (params.from !== -1 && params.to !== -1) {
    const startIdx = len - 1 - Math.min(params.from, len - 1)
    const endIdx = len - 1 - Math.min(params.to, len - 1)
    const lo = Math.max(0, Math.min(startIdx, endIdx))
    const hi = Math.min(len - 1, Math.max(startIdx, endIdx))
    return lines.slice(lo, hi + 1)
  }
  const want = params.tail === -1 ? 200 : params.tail
  return lines.slice(-want)
}

export async function read(
  ctx: McpContext,
  params: { tail: number; from: number; to: number },
): Promise<{ uri: string; mimeType: string; text: string }> {
  const daemon = await requireDaemon(ctx.projectRoot)
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

  // Delegate to the daemon's intrinsic `readClientLog` RPC. The
  // daemon streams the file, applies tail/maxLines/range, and
  // returns the filtered slice — we just re-shape the URI template
  // sentinels (`-1` = "no filter") into the wire shape.
  let result
  try {
    result = await daemon.readClientLog({
      tail: params.tail === -1 ? null : params.tail,
      maxLines: null,
      range: params.from !== -1 && params.to !== -1 ? { from: params.from, to: params.to } : null,
    })
  } catch (err) {
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: `Failed to read client log at \`${clientPath}/logs/latest.log\`: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  return {
    uri: FIXED_URI,
    mimeType: MIME,
    text: result.lines.join('\n'),
  }
}