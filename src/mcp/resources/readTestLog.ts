/**
 * `sandstone://test-log{?tail,maxLines,from,to,since,until}` — test
 * runner log buffer.
 *
 * Reads through the daemon's `readTestLog` RPC, which reads an
 * in-memory buffer populated via `publishLog({target: 'test'})`. The
 * test runner backend isn't wired yet, so the buffer is always empty
 * today — but the resource advertises the same filtering shape as
 * `build-log` so MCP clients get identical semantics once data starts
 * flowing.
 *
 * All six query params required; `-1` skips the corresponding filter.
 *
 * Resource URI: `sandstone://test-log{?tail,maxLines,from,to,since,until}`
 * Format: `text/plain`
 */

import { type McpBridge } from '../bridge.js'
import { coerceFileLogParams, formatLogHeader } from '../../utils/logParams.js'

export const URI = 'sandstone://test-log{?tail,maxLines,from,to,since,until}'
export const FIXED_URI = 'sandstone://test-log'
export const MIME = 'text/plain'
export const NAME = 'test-log'
export const DESCRIPTION = 'Test runner log buffer (in-memory, daemon-side). All six query params required; pass `-1` to skip a filter.'

export async function read(
  bridge: McpBridge,
  params: { tail: number; maxLines: number; from: number; to: number; since: number; until: number },
): Promise<{ uri: string; mimeType: string; text: string }> {
  return bridge.withDaemon(async (daemon) => {
    const result = await daemon.readTestLog(coerceFileLogParams(params))
    return {
      uri: FIXED_URI,
      mimeType: MIME,
      text: `${formatLogHeader('Test runner log', result, [
        result.totalLines === 0
          ? '(no test runner has pushed lines yet — the buffer is reserved for a future backend)'
          : null,
      ])}\n\n${result.lines.join('\n')}`,
    }
  })
}