/**
 * `getLogListener` tool — poll a previously-registered log matcher.
 *
 * Returns the current status. While `pending`, the matcher hasn't
 * settled yet (call again later). Once `matched` or `errored`, the
 * entry is removed from the bridge and the captured result is in
 * `lines` or `error`. The same payload arrives as an MCP notification
 * on `logListener/resolved` if the caller subscribed via that path.
 */

import type { McpBridge } from '../bridge.js'

export const NAME = 'getLogListener'

export const DESCRIPTION =
  'Poll a log matcher registered with `registerLogListener`. Returns the current status; ' +
  'terminal statuses (`matched` / `errored`) include the captured result and remove the entry. ' +
  '**If this call is cancelled by the user before it returns a terminal status, the suppressed `logListener/resolved` notification will still fire later — the agent should NOT call `getLogListener` again with the same id after cancellation; instead, wait for the notification.**'

export async function call(
  bridge: McpBridge,
  args: { id: string },
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const entry = bridge.getLogListener(args.id, signal)
  if (!entry) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `No log listener with id \`${args.id}\` (already settled and removed, or never registered).`,
      }],
    }
  }

  if (entry.status === 'pending') {
    return { content: [{ type: 'text', text: JSON.stringify({ id: args.id, status: 'pending' }) }] }
  }
  if (entry.status === 'matched') {
    return { content: [{ type: 'text', text: JSON.stringify({ id: args.id, status: 'matched', lines: entry.lines }) }] }
  }
  return { content: [{ type: 'text', text: JSON.stringify({ id: args.id, status: 'errored', error: entry.error }) }] }
}