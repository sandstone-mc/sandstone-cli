import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { type McpBridge } from '../bridge.js'
import { restartServer as runRestart, checkRestartCapabilities } from '../../commands/restart-server.js'

export const NAME = 'restartServer'

export const DESCRIPTION =
  'Stop and restart the Minecraft server managed by `sand connect`. ' +
  'The daemon stays alive throughout — only the underlying MC server cycles. ' +
  'Behavior depends on the daemon\'s host provider: ' +
  '`integrated` (child JVM, fast — graceful `stop` via RCON then respawn), ' +
  '`ssh`/`ftp`/`mcsmanager-login` (remote command, slower). ' +
  'Returns an actionable error for `local-client` and pure `rcon` (lifecycle is external). ' +
  'Pair with `resources/subscribe sandstone://rebuild-state` for a push notification, ' +
  'or `resources/read sandstone://server-log` afterwards to confirm clean restart.'

export async function call(
  ctx: McpBridge,
  _args: Record<string, never> = {},
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const daemon = await ctx.requireDaemon()

  const capabilityError = checkRestartCapabilities(daemon.welcome)
  if (capabilityError) {
    return { isError: true, content: [{ type: 'text', text: capabilityError }] }
  }

  try {
    const result = await runRestart(daemon)
    return {
      content: [{
        type: 'text',
        text:
          `Server restarted on \`${result.hostType}\` in ${result.elapsedMs}ms.\n\n` +
          `The daemon stayed alive throughout — only the MC server cycled. ` +
          `Read \`sandstone://server-log\` to verify the server came back up cleanly, ` +
          `or subscribe to \`sandstone://rebuild-state\` for push notifications on the next build.`,
      }],
    }
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err),
    )
  }
}