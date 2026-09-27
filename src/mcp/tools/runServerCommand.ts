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
import { DEFAULT_HOST_TYPES } from '../../commands/connect/index.js'

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
      try {
        const client = await openClient({ endpoint })
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
        } finally {
          client.close()
        }
      } catch (err) {
        // Daemon died mid-flight — fall through to direct.
      }
    }
  }

  // 2. Direct path — bootstrap a host from --host-config.
  const hostTypes = args.hostType
    ? (args.hostType.split(',').map((s) => s.trim()).filter(Boolean) as HostType[])
    : [...DEFAULT_HOST_TYPES]
  const userProvidedHostSettings = !!args.hostType || !!args.hostConfig

  // Build a per-host-type config map. Two shapes accepted, mirroring
  // `sand run`'s direct mode:
  //   - flat shape: `args.hostConfig` itself is a single host's config
  //     (assign it to the first requested type);
  //   - composite shape: `args.hostConfig` is already keyed by host
  //     type (`{ssh:{...}, rcon:{...}}`) and we cast through.
  let perHostConfig: Partial<Record<HostType, HostConfigInput>>
  if (args.hostConfig) {
    perHostConfig = hostTypes.length === 1
      ? { [hostTypes[0]!]: args.hostConfig as HostConfigInput }
      : (args.hostConfig as Partial<Record<HostType, HostConfigInput>>)
  } else {
    perHostConfig = Object.fromEntries(hostTypes.map((t) => [t, {} as HostConfigInput])) as Partial<Record<HostType, HostConfigInput>>
  }
  for (const t of hostTypes) {
    const cfg = perHostConfig[t] as Record<string, unknown> | undefined
    if (cfg && cfg.projectRoot === undefined) cfg.projectRoot = ctx.projectRoot
  }

  let host: HostProvider
  let weStarted: HostType[]
  try {
    const result = await bootstrapHosts({
      hostTypes,
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