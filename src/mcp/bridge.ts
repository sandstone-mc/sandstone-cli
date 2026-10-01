import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { connect as openClient, type Client } from '../commands/connect/client.js'
import { endpointStatus, endpointPath, readEndpoint } from '../commands/connect/endpoint-file.js'
import {
  DaemonUnavailableError,
  forwardConfigChangedToResource,
  forwardNotificationsToStdio,
  type McpContext,
} from './daemon-client.js'

/**
 * Per-MCP-server state. Owns the long-lived daemon `Client` so tools and
 * resources can reuse a single WebSocket connection across the many
 * calls that happen in a typical MCP session (agents routinely fire
 * dozens of tools/resources before the parent closes stdin). Also
 * handles invalidation: when the daemon disconnects or its `onShutdown`
 * fires, the cached client is dropped so the next `requireDaemon()`
 * call transparently reconnects.
 *
 * `dispose()` releases the cached client when the MCP server itself is
 * shutting down.
 */
export class McpBridge {
  private cachedClient: Client | undefined
  private cachedPid: number | undefined
  private offShutdown: (() => void) | undefined
  private forwarderUnsubscribers: Array<() => void> = []

  constructor(public readonly ctx: McpContext) {}

  /**
   * Return the cached daemon client, opening one if needed. On the
   * happy path (subsequent calls in the same MCP session) the same
   * client is returned. If the cached client went stale (daemon
   * restarted → new endpoint file with a different pid, or the WS
   * dropped), this opens a fresh one.
   *
   * Throws `DaemonUnavailableError` when the endpoint file indicates
   * no live daemon — the MCP SDK maps that to a JSON-RPC error
   * payload the agent can act on.
   */
  async requireDaemon(): Promise<Client> {
    const status = await endpointStatus(this.ctx.projectRoot)
    if (status !== 'live') {
      throw new DaemonUnavailableError(
        `sand connect daemon not running. Start it with \`sand connect\` from the project root.`,
        endpointPath(this.ctx.projectRoot),
      )
    }
    const endpoint = await readEndpoint(this.ctx.projectRoot)
    if (!endpoint) {
      throw new DaemonUnavailableError(
        `sand connect daemon not running (no endpoint file). Start it with \`sand connect\`.`,
        endpointPath(this.ctx.projectRoot),
      )
    }

    if (this.cachedClient && this.cachedPid === endpoint.pid) {
      return this.cachedClient
    }

    // Drop any stale client + listeners before opening a new one.
    this.invalidate()

    const client = await openClient({ endpoint })
    this.cachedClient = client
    this.cachedPid = endpoint.pid

    this.offShutdown = client.onShutdown?.(() => {
      this.invalidate()
    })

    return client
  }

  /**
   * Convenience: open the client (cached if available), run `fn`, then
   * always return the result. Errors from `fn` propagate to the caller
   * for handling at the tool/resource layer.
   */
  async withDaemon<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.requireDaemon()
    return fn(client)
  }

  /**
   * Wire the daemon's `configChanged` and generic fallback-notification
   * streams into the MCP server. Safe to call once at server boot.
   * Returns an unsubscribe that detaches the forwarders.
   */
  attachForwarders(mcpServer: McpServer): void {
    void this.requireDaemon()
      .then((client) => {
        this.forwarderUnsubscribers.push(
          forwardConfigChangedToResource(mcpServer.server, client),
        )
        forwardNotificationsToStdio(client, mcpServer)
      })
      .catch(() => {
        // No daemon at boot — agents will hit per-call errors. Forwarders
        // re-attach transparently on the first successful `requireDaemon`.
      })
  }

  dispose(): void {
    this.invalidate()
    this.cachedClient?.close()
  }

  private invalidate(): void {
    this.offShutdown?.()
    this.offShutdown = undefined
    this.forwarderUnsubscribers.forEach((u) => u())
    this.forwarderUnsubscribers = []
    this.cachedClient = undefined
    this.cachedPid = undefined
  }
}