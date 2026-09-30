/**
 * `sandstone://client-log{?tail,from,to}` — Minecraft client
 * (launcher) log.
 *
 * Reads through the daemon's `readFile` RPC, which delegates to the
 * `local-client` host provider when the daemon is configured with one.
 * The MCP server never reads the file directly — that goes through the
 * host abstraction so the same path works for SSH/FTP daemons in the
 * future (reading logs on a remote server).
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
 *   - `saveConfig.clientPath` is unset (user hasn't configured one),
 *   - the daemon host doesn't advertise the `ReadFile` capability.
 *
 * Resource URI: `sandstone://client-log{?tail,from,to}`
 * Format: `text/plain`
 */

import { requireDaemon, type McpContext } from '../daemon-client.js'

export const URI = 'sandstone://client-log{?tail,from,to}'
export const FIXED_URI = 'sandstone://client-log'
export const MIME = 'text/plain'
export const NAME = 'client-log'
export const DESCRIPTION = 'Minecraft client log, read through the daemon\'s host provider (local-client / ssh / ftp). All three query params required; pass `-1` to skip a filter.'

export async function read(
  ctx: McpContext,
  params: { tail: number; from: number; to: number },
): Promise<{ uri: string; mimeType: string; text: string }> {
  const daemon = await requireDaemon(ctx.projectRoot)
  const active = await daemon.getActiveConfig()
  const saveConfig = active.saveConfig

  if (active.mode === 'library') {
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: 'Not applicable in library mode — libraries don\'t deploy to a Minecraft client.',
    }
  }
  const clientPath = saveConfig?.clientPath
  if (!clientPath) {
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: '`saveOptions.clientPath` is not set in `sandstone.config.ts`. Set it to a Minecraft installation directory to enable this resource.',
    }
  }
  if (!daemon.welcome.capabilities.readFile) {
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: `Daemon host \`${daemon.welcome.hostType}\` does not support readFile. Use a host provider that can read files (e.g. \`local-client\`, \`ssh\`, \`ftp\`).`,
    }
  }

  // Read the standard client log location. The local-client host resolves
  // relative paths against `clientPath`; absolute paths read directly.
  const logRelative = 'logs/latest.log'
  let text: string
  try {
    // `encode: 'utf-8'` consumes the streaming RPC server-side and
    // returns a single string. If the caller forgot to pass
    // `encode`, the daemon returns raw bytes — decode here so the
    // MCP resource surface stays UTF-8.
    const result = await daemon.readFile({ path: logRelative, encode: 'utf-8' })
    text = typeof result.data === 'string' ? result.data : Buffer.from(result.data).toString('utf-8')
  } catch (err) {
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: `Failed to read client log at \`${clientPath}/${logRelative}\`: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Filter: split into lines (line 0 = last line = newest), apply
  // range/tail in the MCP layer since the host provider only returns
  // a byte buffer.
  const allLines = text.split('\n')
  // Drop a trailing empty produced by terminal newline (file ends with \n).
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  const filtered = applyLogRange(allLines, params)

  return {
    uri: FIXED_URI,
    mimeType: MIME,
    text: filtered.join('\n'),
  }
}

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