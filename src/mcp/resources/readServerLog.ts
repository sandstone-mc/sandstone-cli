/**
 * `sandstone://server-log{?tail,maxLines,from,to,since,until}` — Minecraft
 * server log.
 *
 * Reads from the daemon's in-memory buffer (populated via the host's
 * `attachLog` at daemon boot). Works in pack and library mode — library
 * test workspaces deploy to a server too, and the daemon's buffer is
 * populated regardless of whether a watcher is running.
 *
 * Query params (all six REQUIRED on every call — MCP SDK 1.30.1's
 * form-style `{?var}` matching fails if any declared var is missing).
 * Pass `-1` for any filter you don't want — that's the sentinel for
 * "no filter applied".
 *
 *   - `tail=N`     — last N lines when no range filter matches more.
 *                   `-1` = use default (200).
 *   - `maxLines=N` — hard cap on lines returned. `-1` = use default
 *                   (1000).
 *   - `from=N`     — lower line-ID bound (inclusive). `0` = most
 *                   recent. `-1` = no range filter.
 *   - `to=N`       — upper line-ID bound (inclusive). Same as `from`.
 *                   `-1` = no range filter.
 *   - `since=N`    — seconds-relative-to-now lower time bound. `-1` =
 *                   no time filter.
 *   - `until=N`    — seconds-relative-to-now upper time bound. `-1` =
 *                   no time filter.
 *
 * Range + time filter intersect. When both apply, lines must match
 * both to be included.
 *
 * Resource URI: `sandstone://server-log{?tail,maxLines,from,to,since,until}`
 * Format: `text/plain`
 */

import { requireDaemon, type McpContext } from '../daemon-client.js'

export const URI = 'sandstone://server-log{?tail,maxLines,from,to,since,until}'
export const FIXED_URI = 'sandstone://server-log'
export const MIME = 'text/plain'
export const NAME = 'server-log'
export const DESCRIPTION = 'Minecraft server log, read from the daemon\'s in-memory buffer (populated via the host\'s `attachLog` at daemon boot). All six query params required; pass `-1` to skip a filter.'

export async function read(
  ctx: McpContext,
  params: {
    tail: number
    maxLines: number
    from: number
    to: number
    since: number
    until: number
  },
): Promise<{ uri: string; mimeType: string; text: string }> {
  const daemon = await requireDaemon(ctx.projectRoot)
  const result = await daemon.readServerLog({
    tail: params.tail === -1 ? null : params.tail,
    maxLines: params.maxLines === -1 ? null : params.maxLines,
    range: params.from !== -1 && params.to !== -1 ? { from: params.from, to: params.to } : null,
    since: params.since === -1 ? null : params.since,
    until: params.until === -1 ? null : params.until,
  })
  const header = [
    `# Server log (${result.lines.length} of ${result.matchedLines} matched; ${result.totalLines} buffered)`,
    result.oldestTs ? `oldest: ${result.oldestTs}` : null,
    result.newestTs ? `newest: ${result.newestTs}` : null,
    result.truncated ? 'TRUNCATED — increase tail/maxLines or narrow range/since' : null,
  ].filter(Boolean).join('\n')
  return {
    uri: FIXED_URI,
    mimeType: MIME,
    text: `${header}\n\n${result.lines.join('\n')}`,
  }
}