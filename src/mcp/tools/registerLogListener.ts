/**
 * `registerLogListener` tool — register a single log pattern matcher.
 *
 * Returns a handle the caller can either:
 *  - poll with `getLogListener({ id })` until the status is `matched`
 *    or `errored`; OR
 *  - listen for the `logListener/resolved` MCP notification (fires once
 *    the matcher settles).
 *
 * Matchers are daemon-side (LogMatcher), so the `sand connect` daemon
 * must be running. Registration does not block — the tool returns
 * immediately with `status: 'pending'`.
 */

import { DaemonUnavailableError } from '../daemon-client.js'
import type { McpBridge } from '../bridge.js'
import type { LogPattern } from '../../commands/connect/wait-log.js'

export const NAME = 'registerLogListener'

export const DESCRIPTION =
  'Register a single log pattern matcher against the `sand connect` daemon. ' +
  'Returns an `id` the agent can poll via `getLogListener` or listen for via the ' +
  '`logListener/resolved` MCP notification (fires once on settlement). ' +
  '**Prefer `runServerCommand`\'s `waitFor` argument when you\'re running a command and want to capture its own output** — this tool is for the case where you need to watch a log line that has nothing to do with a command you\'re sending.'

export async function call(
  bridge: McpBridge,
  args: { pattern: LogPattern },
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  let daemon
  try {
    daemon = await bridge.requireDaemon()
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: '`registerLogListener` requires the `sand connect` daemon (LogMatcher is daemon-side).',
        }],
      }
    }
    throw err
  }

  const handle = await bridge.registerLogListener(daemon, args.pattern)
  if (signal) {
    signal.addEventListener('abort', () => { void handle.handle.cancel() }, { once: true })
  }
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        id: handle.id,
        status: 'pending',
      }),
    }],
  }
}