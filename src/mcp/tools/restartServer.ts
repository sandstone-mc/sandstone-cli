/**
 * `restartServer` tool.
 *
 * Stops the Minecraft server managed by the `sand connect` daemon,
 * then starts it back up. The daemon itself stays alive throughout
 * — only the underlying MC server cycles. Works for every host
 * provider that advertises both `stopServer` and `startServer`
 * capabilities (today: `integrated`, `ssh`, `mcsmanager-login`).
 *
 * # How it works
 *
 *   1. `daemon.stopServer({timeoutSeconds})` — host provider stops the
 *      MC server. For `integrated`, this sends `stop` via RCON
 *      (graceful: MC saves worlds, broadcasts goodbye, JVM exits).
 *
 *   2. `daemon.startServer()` — host provider starts it back up.
 *      `integrated.startServer` respawns the child JVM. The
 *      integrated host re-establishes its RCON connection before
 *      returning.
 *
 * The daemon's `host-lost` watcher sees the disconnect but the
 * integrated host sets `rconCloseExpected = true` first, so the
 * watcher no-ops and the daemon stays up throughout the cycle.
 *
 * # Pair with...
 *
 *   - `resources/subscribe sandstone://rebuild-state` for a push
 *     notification when the server comes back.
 *   - `resources/read sandstone://server-log` afterwards to confirm
 *     a clean restart.
 *
 * # Capabilities precheck
 *
 * Both `stopServer` AND `startServer` are required. Missing either
 * returns an actionable error:
 *   - `local-client`: launcher owns the lifecycle (use the launcher).
 *   - Pure `ftp`: lifecycle is external (use external controls).
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { requireDaemon, type McpContext } from '../daemon-client.js'

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
  ctx: McpContext,
  args: { timeoutSeconds?: number } = {},
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const daemon = await requireDaemon(ctx.projectRoot)
  const welcome = daemon.welcome
  const caps = welcome.capabilities

  // Capability precheck: stopServer and startServer are independent
  // capabilities per host. Surface which is missing so the agent
  // knows why and what to do instead.
  if (!caps.stopServer && !caps.startServer) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `Daemon host \`${welcome.hostType}\` supports neither stopServer nor startServer — it can't manage the server lifecycle. ` +
          `For \`local-client\` hosts the launcher owns the lifecycle (use the launcher UI). ` +
          `For pure \`rcon\` hosts the server lifecycle is external.`,
      }],
    }
  }
  if (!caps.stopServer) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `Daemon host \`${welcome.hostType}\` supports startServer but not stopServer. ` +
          `Use the host's own lifecycle controls (e.g. launcher UI for local-client) — this tool needs both.`,
      }],
    }
  }
  if (!caps.startServer) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `Daemon host \`${welcome.hostType}\` supports stopServer but not startServer. ` +
          `Use the host's own lifecycle controls.`,
      }],
    }
  }

  const timeoutSeconds = args.timeoutSeconds ?? 30

  const stopStart = Date.now()
  try {
    await daemon.stopServer({ timeoutSeconds })
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to stop the server: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  try {
    await daemon.startServer()
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Server stopped but failed to restart: ${err instanceof Error ? err.message : String(err)}. ` +
        `The daemon is alive and the server may need a manual start.`,
    )
  }

  const elapsedMs = Date.now() - stopStart
  return {
    content: [{
      type: 'text',
      text:
        `Server restarted on \`${welcome.hostType}\` in ${elapsedMs}ms.\n\n` +
        `The daemon stayed alive throughout — only the MC server cycled. ` +
        `Read \`sandstone://server-log\` to verify the server came back up cleanly, ` +
        `or subscribe to \`sandstone://rebuild-state\` for push notifications on the next build.`,
    }],
  }
}