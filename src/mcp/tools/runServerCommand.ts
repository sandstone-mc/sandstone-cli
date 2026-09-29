/**
 * `runServerCommand` tool — send a Minecraft console command.
 *
 * Mirrors `sand run <command>`:
 *   1. If `sand connect` daemon is alive for this project, forward the
 *      command over its WebSocket (`executeRawCommand` RPC).
 *   2. Otherwise, bootstrap a direct host connection (same path
 *      `sand run` direct mode takes) and send the command through that.
 *
 * Bootstrap behaviour was a hard lock-in from the user — this tool
 * always tries to do the work, never errors with "daemon unavailable".
 * That's distinct from `getSaveConfig`/`readClientLog`/etc., which are
 * read-only observers and DO fail cleanly when the daemon is down.
 *
 * Returns:
 *   - `{content: [{type:'text', text: <output>}]}` on success.
 *   - `{isError: true, content: [{type:'text', text: <error>}]}` when
 *     the command itself failed (recoverable — agent can retry).
 *   - Throws `DaemonUnavailableError`/`BootstrapError` only when
 *     bootstrap itself failed (user-action error).
 */

import { run as shell } from '../../utils/shell.js'
import { bootstrapHosts, BootstrapError } from '../../commands/connect/bootstrap.js'
import { connect as openClient } from '../../commands/connect/client.js'
import { endpointStatus, readEndpoint, endpointPath } from '../../commands/connect/endpoint-file.js'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import type { McpContext } from '../daemon-client.js'
import type { HostProvider, HostType, HostConfigInput } from '../../hosts/types.js'
import { DEFAULT_HOST_TYPE } from '../../commands/connect/index.js'

export const NAME = 'runServerCommand'
export const DESCRIPTION =
  'Send a Minecraft console command via the host daemon. Bootstrap behaviour: connects to `sand connect` if alive, otherwise spawns a direct host connection (matches `sand run` semantics).'

export async function call(
  ctx: McpContext,
  args: {
    command: string
    hostType?: string
    hostConfig?: HostConfigInput
    expect?: string
    timeoutSeconds?: number
  },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!args.command || !args.command.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Missing `command` argument.' }],
    }
  }

  // 1. Daemon path — preferred when alive.
  const status = await endpointStatus(ctx.projectRoot)
  if (status === 'live') {
    const endpoint = await readEndpoint(ctx.projectRoot)
    if (endpoint) {
      // Two distinct failure modes must NOT be conflated:
      //   - `openClient` throws  → daemon is unreachable, fall through
      //     to direct-path bootstrap (mirrors `sand run` semantics).
      //   - `client.executeRawCommand` throws → daemon is up but the
      //     command failed (e.g. `rcon host is not connected` while
      //     the daemon is mid-restart). DO NOT fall through — that
      //     would spawn a second JVM in the MCP process which then
      //     collides on the world directory lock held by the daemon's
      //     JVM. Return the error verbatim.
      let client
      try {
        client = await openClient({ endpoint })
      } catch {
        // Daemon unreachable — fall through to direct.
      }
      if (client) {
        try {
          if (!client.welcome.capabilities.executeRawCommand) {
            return {
              isError: true,
              content: [{
                type: 'text',
                text: `Host \`${endpoint.hostType}\` does not support executeRawCommand.`,
              }],
            }
          }
          if (client.welcome.capabilities.startServer) {
            await client.startServer().catch(() => {})
          }
          const result = await client.executeRawCommand({ command: args.command })
          return {
            content: [{
              type: 'text',
              text: result.output || '(no output)',
            }],
          }
        } catch (err) {
          // Daemon is alive but the command failed — surface the error.
          return {
            isError: true,
            content: [{
              type: 'text',
              text: err instanceof Error ? err.message : String(err),
            }],
          }
        } finally {
          client.close()
        }
      }
    }
  }

  // 2. Direct path — bootstrap a host from --host-config. The direct
  // path runs when no daemon is available; it's the only remaining
  // host selection mechanism since composite daemons were removed.
  const hostType: HostType = args.hostType
    ? (args.hostType as HostType)
    : DEFAULT_HOST_TYPE
  const userProvidedHostSettings = !!args.hostType || !!args.hostConfig

  // Build the per-host-type config map. Flat shape accepted for
  // back-compat with single-host invocations.
  let perHostConfig: Partial<Record<HostType, HostConfigInput>>
  if (args.hostConfig) {
    perHostConfig = { [hostType]: args.hostConfig as HostConfigInput }
  } else {
    perHostConfig = { [hostType]: {} as HostConfigInput }
  }
  const cfg = perHostConfig[hostType] as Record<string, unknown> | undefined
  if (cfg && cfg.projectRoot === undefined) cfg.projectRoot = ctx.projectRoot

  let host: HostProvider
  let weStarted: HostType[]
  try {
    const result = await bootstrapHosts({
      hostType,
      perHostConfig,
      silent: true,
      userProvidedHostSettings,
    })
    host = result.host
    weStarted = result.spawnedByUs
  } catch (err) {
    if (err instanceof BootstrapError) {
      throw new McpError(
        ErrorCode.InternalError,
        `${err.message} (${err.code})`,
        { error: 'bootstrap-failed', code: err.code },
      )
    }
    throw err
  }

  try {
    if (!host.capabilities.has('executeRawCommand' as never)) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Host does not support executeRawCommand.`,
        }],
      }
    }
    const output = await host.executeRawCommand!(args.command)
    return {
      content: [{
        type: 'text',
        text: output || '(no output)',
      }],
    }
  } catch (err) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
      }],
    }
  } finally {
    if (weStarted.length > 0 && host.stopServer) {
      await host.stopServer().catch(() => {})
    }
    await host.disconnect().catch(() => {})
  }
}

// silence unused import linter
void shell
void endpointPath