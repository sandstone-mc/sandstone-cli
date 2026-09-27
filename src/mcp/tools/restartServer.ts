/**
 * `restartServer` tool — v1 stub.
 *
 * Would send `stop` then `start` via the host. Agent should use
 * `runServerCommand` with `stop` + `start` console commands (or just
 * Bash to kill + relaunch the JVM) for now.
 */

import type { McpContext } from '../daemon-client.js'

export const NAME = 'restartServer'
export const DESCRIPTION =
  'Stop and restart the Minecraft server managed by `sand connect`. v1 stub — use `runServerCommand` to send `stop` + wait + relaunch, or restart via the launcher directly.'

export async function call(
  _ctx: McpContext,
  _args: { timeoutSeconds?: number },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: 'restartServer is a v1 stub. Send `stop` via `runServerCommand`, wait for shutdown, then relaunch.',
    }],
  }
}