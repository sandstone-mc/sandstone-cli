/**
 * Daemon client wrapper for the MCP server.
 *
 * The MCP server is a *consumer* of `sand connect` — it connects to the
 * daemon's WebSocket and translates MCP `resources/*` / `tools/*`
 * requests into daemon RPCs. This module:
 *   - reads the endpoint file (`.sandstone/connect.url`) to discover
 *     the daemon's URL + secret,
 *   - opens a `Client` connection via the existing `connect/client.ts`,
 *   - exposes typed helpers (`getActiveConfig`, `getBuildOutputTree`,
 *     `readBuildLog`) that resource/tool handlers can call,
 *   - subscribes to `configChanged` events and republishes them as
 *     `notifications/resources/updated` on the MCP server.
 *
 * Bootstrap behaviour: when the daemon isn't running, callers should
 * surface an MCP `McpError` (NOT try to spawn the daemon — that's
 * `sand run`'s job, and only for tools that actually need a host). The
 * {@link requireDaemon} helper throws a `DaemonUnavailableError` with
 * structured `data` so the MCP SDK maps it to a protocol-level error
 * the agent can act on.
 */

import { resolve } from 'node:path'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { connect as openClient, type Client } from '../commands/connect/client.js'
import { endpointStatus, endpointPath, readEndpoint } from '../commands/connect/endpoint-file.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

/**
 * Thrown by {@link requireDaemon} when no `sand connect` daemon is
 * running for the project. The MCP SDK maps any thrown error to a
 * JSON-RPC error envelope; the `code` and `data` properties survive
 * (the SDK respects `McpError.code`/`data`).
 */
export class DaemonUnavailableError extends McpError {
  constructor(
    message: string,
    public readonly connectUrl: string,
  ) {
    super(ErrorCode.InternalError, message, {
      error: 'daemon-unavailable',
      connectUrl,
      remediation: 'Run `sand connect` from the project root, then retry.',
    })
    this.name = 'DaemonUnavailableError'
  }
}

/**
 * Bootstrap a daemon `Client`. Throws {@link DaemonUnavailableError}
 * when the daemon isn't running for the project. Returns the underlying
 * `Client` so callers can also subscribe to events (e.g.
 * `onConfigChanged`).
 */
export async function requireDaemon(projectRoot: string): Promise<Client> {
  const status = await endpointStatus(projectRoot)
  if (status !== 'live') {
    throw new DaemonUnavailableError(
      `sand connect daemon not running. Start it with \`sand connect\` from the project root.`,
      endpointPath(projectRoot),
    )
  }
  const endpoint = await readEndpoint(projectRoot)
  if (!endpoint) {
    throw new DaemonUnavailableError(
      `sand connect daemon not running (no endpoint file). Start it with \`sand connect\`.`,
      endpointPath(projectRoot),
    )
  }
  return openClient({ endpoint })
}

/**
 * Convenience: format a thrown error as MCP-shape data. Use this in
 * tool/resource handlers when you want consistent `{error, ...}`
 * payloads without leaking SDK-internal shape.
 */
export function mcpErrorData(err: unknown): Record<string, unknown> {
  if (err instanceof DaemonUnavailableError) {
    return { ...(err.data ?? {}), connectUrl: err.connectUrl }
  }
  if (err instanceof Error) {
    return { error: err.name || 'Error', message: err.message }
  }
  return { error: 'unknown', message: String(err) }
}

/**
 * Wire the daemon → MCP notification bridge. The MCP server is a WS
 * client of the daemon AND a stdio server to the MCP client. Without
 * this, daemon-pushed notifications (e.g. `notifications/resources/updated`
 * for `sandstone://rebuild-state`) die in the WS receive path —
 * the SDK's default `_onnotification` for the Client side just runs
 * the typed handlers (configChanged, log, etc.), not a generic
 * re-emit.
 *
 * The fallback handler installed here catches every unhandled WS
 * notification and re-emits it on the MCP server's stdio transport
 * via `server.server.notification(...)`. Subscribed MCP clients see
 * the events live.
 */
export function forwardNotificationsToStdio(
  daemonClient: Client,
  mcpServer: { server: { notification(notif: { method: string; params?: unknown }): Promise<void> } },
): void {
  daemonClient.setFallbackNotificationHandler(async (notif) => {
    await mcpServer.server.notification({ method: notif.method, params: notif.params })
  })
}

/**
 * Project root path. `sand mcp` is invoked with `--path <dir>` (same
 * flag as every other sand command) — we resolve it once at server
 * boot and pass it to every handler.
 */
export interface McpContext {
  projectRoot: string
}

/** Construct the path-resolved context used by every MCP handler. */
export function makeContext(opts: { path: string }): McpContext {
  return { projectRoot: resolve(opts.path) }
}

/**
 * Wire the daemon's `configChanged` events to MCP
 * `notifications/resources/updated` for the `sandstone://save-config`
 * URI. Other resources (logs, output tree) are derivable from that, so
 * a single subscription refreshes everything the agent cares about.
 *
 * Returns an unsubscribe function so the MCP server can detach on
 * shutdown.
 */
export function forwardConfigChangedToResource(
  server: Server,
  client: Client,
  uri: string = 'sandstone://save-config',
): () => void {
  return client.onConfigChanged(() => {
    void server.sendResourceUpdated({ uri }).catch(() => {
      // Client may have disconnected; no way to surface this from a
      // notification handler. Swallow.
    })
  })
}