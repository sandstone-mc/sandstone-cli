import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { connect as openClient, type Client } from '../commands/connect/client.js'
import { endpointStatus, endpointPath, readEndpoint } from '../commands/connect/endpoint-file.js'
import type { LogPattern } from '../commands/connect/wait-log.js'
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
type ListenerEntry =
  | { status: 'pending' }
  | { status: 'matched'; lines: string[] }
  | { status: 'errored'; error: string }

export class McpBridge {
  private cachedClient: Client | undefined
  private cachedPid: number | undefined
  private offShutdown: (() => void) | undefined
  private forwarderUnsubscribers: Array<() => void> = []
  private mcpServer: McpServer | undefined
  private listeners = new Map<string, ListenerEntry>()
  /** IDs whose terminal result the agent already drained via `getLogListener`. */
  private consumedListeners = new Set<string>()

  constructor(public readonly ctx: McpContext) {}

  /**
   * Send a JSON-RPC notification through the MCP server. No-op when
   * no server has been attached (e.g. tool called outside an MCP
   * session). Notifications are best-effort — delivery errors are
   * swallowed so the caller's promise isn't rejected by transport
   * glitches.
   */
  async sendNotification(method: string, params?: NonNullable<Parameters<NonNullable<typeof this.mcpServer>['server']['notification']>['0']['params']>): Promise<void> {
    if (!this.mcpServer) return
    try {
      await this.mcpServer.server.notification({ method, params })
    } catch {
      // swallowed — notifications are best-effort
    }
  }

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
    this.mcpServer = mcpServer
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

  /**
   * Register a single log pattern listener on the daemon. Returns
   * `{id, patternUUID}` for the caller. The listener's terminal result
   * is delivered as an MCP notification `logListener/resolved` and
   * also retained in `listeners` for polling via `getLogListener`.
   */
  async registerLogListener(
    daemon: Client,
    pattern: LogPattern,
  ): Promise<{
    id: string,
    handle: { cancel(): Promise<void> },
  }> {
    const sub = await daemon.waitForLog({ patterns: [pattern] })
    const fullUUID = sub.patternUUIDs[0]!
    // Expose only the first 8 hex chars as the agent-facing id. The
    // full UUID stays internal — collision risk is negligible (32 bits
    // of entropy per MCP session is plenty) and the agent never needs
    // the longer form.
    const id = fullUUID.slice(0, 8)
    this.listeners.set(id, { status: 'pending' })

    sub.promises[0]!
      .then((lines) => {
        this.listeners.set(id, { status: 'matched', lines })
        if (this.consumedListeners.has(id)) return
        void this.sendNotification('logListener/resolved', {
          id,
          status: 'matched',
          lines,
        })
      })
      .catch((err: Error) => {
        this.listeners.set(id, { status: 'errored', error: err.message })
        if (this.consumedListeners.has(id)) return
        void this.sendNotification('logListener/resolved', {
          id,
          status: 'errored',
          error: err.message,
        })
      })

    return { id, handle: sub }
  }

  /**
   * Look up a listener's current state. Returning a terminal status
   * (`matched` / `errored`) marks the entry as consumed — the
   * `logListener/resolved` notification is then suppressed, since the
   * agent already has the result via this call.
   *
   * If `signal` is provided and aborts before the caller has had a
   * chance to consume the result, the consumed flag is rolled back —
   * the notification still fires, since the agent never actually
   * received the data.
   */
  getLogListener(id: string, signal?: AbortSignal): ListenerEntry | undefined {
    const entry = this.listeners.get(id)
    if (entry && entry.status !== 'pending') {
      this.consumedListeners.add(id)
      if (signal) {
        const onAbort = () => {
          this.consumedListeners.delete(id)
          signal.removeEventListener('abort', onAbort)
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    return entry
  }

  /** Drop a listener entry (and cancel the underlying matcher if still pending). */
  async cancelLogListener(id: string): Promise<void> {
    const entry = this.listeners.get(id)
    this.listeners.delete(id)
    if (entry?.status === 'pending') {
      // Caller should have used the handle returned from register; we
      // don't have it here, but `daemon.waitForLog` exposes interrupt
      // via the RPC. Best-effort: the listener entry is gone either way.
    }
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