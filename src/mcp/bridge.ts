import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { Client as DaemonClient } from '../commands/connect/client.js'
import { endpointStatus, endpointPath, readEndpoint } from '../commands/connect/endpoint-file.js'
import type { LogPattern } from '../commands/connect/wait-log.js'
import {
  DaemonUnavailableError,
  forwardConfigChangedToResource,
  forwardNotificationsToStdio,
  type McpContext,
} from './daemon-client.js'

type ListenerEntry =
  | { status: 'pending' }
  | { status: 'matched'; lines: string[] }
  | { status: 'errored'; error: string }

export class McpBridge {
  private cachedClient: DaemonClient | undefined
  private cachedPid: number | undefined
  private offShutdown: (() => void) | undefined
  private forwarderUnsubscribers: Array<() => void> = []
  private mcpServer: McpServer | undefined
  private listeners = new Map<string, ListenerEntry>()
  /** IDs whose terminal result the agent already drained via `getLogListener`. */
  private consumedListeners = new Set<string>()

  constructor(public readonly ctx: McpContext) {}

  async sendNotification(method: string, params?: NonNullable<Parameters<NonNullable<typeof this.mcpServer>['server']['notification']>['0']['params']>): Promise<void> {
    if (!this.mcpServer) return
    try {
      await this.mcpServer.server.notification({ method, params })
    } catch {}
  }

  async requireDaemon() {
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

    this.invalidate()

    const client = await DaemonClient.open({ endpoint })
    this.cachedClient = client
    this.cachedPid = endpoint.pid

    this.offShutdown = client.onShutdown?.(() => {
      this.invalidate()
    })

    return client
  }

  async withDaemon<T>(fn: (client: DaemonClient) => Promise<T>): Promise<T> {
    const client = await this.requireDaemon()
    return fn(client)
  }

  attachForwarders(mcpServer: McpServer): void {
    this.mcpServer = mcpServer
    void this.requireDaemon()
      .then((client) => {
        this.forwarderUnsubscribers.push(
          forwardConfigChangedToResource(mcpServer.server, client),
        )
        forwardNotificationsToStdio(client, mcpServer)
      })
      .catch(() => {})
  }

  dispose(): void {
    this.invalidate()
    this.cachedClient?.close()
  }

  async registerLogListener(
    daemon: DaemonClient,
    pattern: LogPattern,
  ): Promise<{
    id: string,
    handle: { cancel(): Promise<void> },
  }> {
    const sub = await daemon.waitForLog({ patterns: [pattern] })
    const fullUUID = sub.patternUUIDs[0]!
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

  async cancelLogListener(id: string): Promise<void> {
    const entry = this.listeners.get(id)
    this.listeners.delete(id)
    if (entry?.status === 'pending') {
      // TODO: Investigate
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