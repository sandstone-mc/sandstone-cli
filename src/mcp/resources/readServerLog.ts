/**
 * `sandstone://server-log{?tail,from,to}` — Minecraft server log.
 *
 * Reads through the daemon's `readFile` RPC, which delegates to the
 * host provider (`integrated` writes its own log; `ssh`/`ftp` fetch
 * from the remote server's directory). Same path-as-abstraction as
 * `readClientLog`.
 *
 * Query params (all three are REQUIRED on every call). Pass `-1` for
 * the line-ID bounds to skip the range filter.
 *
 * Returns a helpful message when:
 *   - mode is library (no server deploy target),
 *   - `saveConfig.serverPath` is unset (user hasn't configured one),
 *   - the daemon host doesn't advertise the `ReadFile` capability.
 *
 * Resource URI: `sandstone://server-log{?tail,from,to}`
 * Format: `text/plain`
 */

import { requireDaemon, type McpContext } from '../daemon-client.js'
import { applyLogRange } from './readClientLog.js'

export const URI = 'sandstone://server-log{?tail,from,to}'
export const FIXED_URI = 'sandstone://server-log'
export const MIME = 'text/plain'
export const NAME = 'server-log'
export const DESCRIPTION = 'Minecraft server log, read through the daemon\'s host provider (integrated / ssh / ftp). All three query params required; pass `-1` to skip a filter.'

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
      text: 'Not applicable in library mode — libraries don\'t deploy to a Minecraft server.',
    }
  }
  const serverPath = saveConfig?.serverPath
  if (!serverPath) {
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: '`saveOptions.serverPath` is not set in `sandstone.config.ts`. Set it to a Minecraft server directory to enable this resource.',
    }
  }
  if (!daemon.welcome.capabilities.readFile) {
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: `Daemon host \`${daemon.welcome.hostType}\` does not support readFile. Use a host provider that can read files.`,
    }
  }

  // Standard MC server log location. The integrated host's readFile
  // joins with serverDir; SSH/FTP transfer the path to the remote.
  const logRelative = 'logs/latest.log'
  let text: string
  try {
    const result = await daemon.readFile({ path: logRelative })
    text = Buffer.from(result.data, 'base64').toString('utf-8')
  } catch (err) {
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: `Failed to read server log at \`${serverPath}/${logRelative}\`: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const allLines = text.split('\n')
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  const filtered = applyLogRange(allLines, params)

  return {
    uri: FIXED_URI,
    mimeType: MIME,
    text: filtered.join('\n'),
  }
}