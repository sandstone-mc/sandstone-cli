import { bootstrapHost, BootstrapError } from '../../commands/connect/bootstrap.js'
import { Client as DaemonClient } from '../../commands/connect/client.js'
import { NULL_LOGGER } from '../../commands/connect/logger.js'
import { endpointStatus, readEndpoint } from '../../commands/connect/endpoint-file.js'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import type { McpBridge } from '../bridge.js'
import type { HostProvider, HostType, HostConfigInput } from '../../hosts/types.js'
import { DEFAULT_HOST_TYPE } from '../../commands/connect/index.js'
import type { LogPattern } from '../../commands/connect/wait-log.js'

export const NAME = 'runServerCommand'
export const DESCRIPTION =
  'Send a Minecraft console command via the host daemon. Bootstrap behaviour: connects to `sand connect` if alive, otherwise spawns a direct host connection (matches `sand run` semantics). ' +
  'Pass `waitFor` to register a log pattern that fires before the command runs; the result (lines or timeout error) is sent as an MCP notification once it settles.'

export async function call(
  bridge: McpBridge,
  args: {
    command: string,
    hostType?: string,
    hostConfig?: HostConfigInput,
    expect?: string,
    waitFor?: LogPattern,
  },
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!args.command || !args.command.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Missing `command` argument.' }],
    }
  }

  // 1. Daemon path — preferred when alive.
  const status = await endpointStatus(bridge.ctx.projectRoot)
  if (status === 'live') {
    const endpoint = await readEndpoint(bridge.ctx.projectRoot)
    if (endpoint) {
      let client
      try {
        client = await DaemonClient.open({ endpoint, logger: NULL_LOGGER })
      } catch {}
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
          const result = await client.executeRawCommand({
            command: args.command,
            ...(args.waitFor ? { waitFor: args.waitFor } : {}),
          }, signal)

          if (result.logResult) {
            const patternUUID = result.patternUUID?.slice(0, 8)
            const logResult = result.logResult
            const cancel = result.cancel
            if (signal) {
              const onAbort = () => { void cancel?.() }
              signal.addEventListener('abort', onAbort, { once: true })
              logResult.finally(() => signal.removeEventListener('abort', onAbort))
            }
            void logResult
              .then((lines) => bridge.sendNotification('runServerCommand/waitFor', {
                command: args.command,
                patternUUID,
                status: 'matched',
                lines,
              }))
              .catch((err: Error) => bridge.sendNotification('runServerCommand/waitFor', {
                command: args.command,
                patternUUID,
                status: 'errored',
                error: err.message,
              }))
          }

          return {
            content: [{
              type: 'text',
              text: (result.output || '(no output)') +
                (result.patternUUID
                  ? `\n\n(waitFor registered: patternUUID=${result.patternUUID.slice(0, 8)})`
                  : ''),
            }],
          }
        } catch (err) {
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
  if (args.waitFor) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: '`waitFor` requires the `sand connect` daemon (LogMatcher is daemon-side). Re-run without `waitFor` to fall through to direct mode, or start the daemon.',
      }],
    }
  }

  const hostType: HostType = args.hostType
    ? (args.hostType as HostType)
    : DEFAULT_HOST_TYPE
  const userProvidedHostSettings = !!args.hostType || !!args.hostConfig

  if (args.hostConfig && args.hostConfig.projectRoot === undefined) args.hostConfig.projectRoot = bridge.ctx.projectRoot

  let host: HostProvider
  let weStarted = false
  try {
    const result = await bootstrapHost({
      hostType,
      config: args.hostConfig ?? {},
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
    if (weStarted && host.stopServer) {
      await host.stopServer().catch(() => {})
    }
    await host.disconnect().catch(() => {})
  }
}