/**
 * `deployToServer` tool — v1 stub.
 *
 * Would build the project and push the resulting pack to the running
 * server (via `saveOptions.serverPath` or via RCON). For now, the
 * agent should run `sand build` via Bash, then copy the output from
 * `.sandstone/output/` to the server directory.
 */

import type { McpContext } from '../daemon-client.js'

export const NAME = 'deployToServer'
export const DESCRIPTION =
  'Build the project and deploy the resulting pack to the configured Minecraft server. v1 stub — use `sand build` + manual copy for now.'

export async function call(
  _ctx: McpContext,
  _args: { dry?: boolean },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: 'deployToServer is a v1 stub. Run `sand build` via Bash and copy `.sandstone/output/datapack` to your server\'s `world/datapacks/` directory.',
    }],
  }
}