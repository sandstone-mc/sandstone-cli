/**
 * Daemon orchestrator.
 *
 * Lifecycle:
 *   1. Validate the project's endpoint file isn't already serving a live
 *      daemon (pidAlive + age check).
 *   2. Instantiate the requested HostProvider via the registry.
 *   3. Start the WS server (host not yet connected; server is
 *      'welcome'-only until the host connects).
 *   4. Write the endpoint file.
 *   5. Register SIGINT/SIGTERM (and SIGBREAK on Windows) handlers.
 *   6. On signal or `shutdown` RPC, run the shutdown sequence:
 *      - Flush any pending log batches.
 *      - Drop all subscriptions.
 *      - Disconnect the host.
 *      - Delete the endpoint file.
 *      - Stop the server.
 *      - `process.exit(0)`.
 *
 * The shutdown sequence is idempotent; multiple triggers (signal +
 * RPC + another signal) collapse to one execution.
 */

import { capabilitiesToRecord, Capability, type HostConfigInput, type HostProvider, type HostType } from '../../hosts/types.js'
import { BootstrapError, bootstrapHost } from './bootstrap.js'
import { loadActiveConfigFromDisk, type ActiveConfig } from './active-config.js'

/**
 * Module-level state shared with `dispatch.ts` so handlers can flag
 * an imminent disconnect as expected (e.g. `runServerCommand("stop")`,
 * `restartServer`). The host-lost watcher consumes the flag and
 * leaves the daemon alive. One-shot — cleared after the next member
 * disconnect fires.
 */
let expectedShutdown = false
export const setExpectedShutdown = (v: boolean) => { expectedShutdown = v }
export const getExpectedShutdown = () => expectedShutdown
import { startServer, WsData } from './server.js'
import type { RebuildState, WatcherStatus } from './rpc.js'
import {
  deleteEndpoint,
  endpointPath,
  endpointStatus,
  generateSecret,
  writeEndpoint,
  type EndpointFile,
} from './endpoint-file.js'

export interface DaemonOptions {
  hostType: HostType
  config: Partial<HostConfigInput>
  projectRoot: string
  /** Bind address. Default `127.0.0.1`. */
  bind?: string
  /** Bind port. `0` lets the OS pick. */
  port?: number
  /**
   * Forwarded to {@link BootstrapOptions.userProvidedHostSettings}.
   * When true, the caller passed explicit `--host-type` / `--host-config`
   * / `--host-config-file` — suppresses the auto-`local-client` default.
   */
  userProvidedHostSettings?: boolean
}

/** Result of a successful daemon start. */
export interface DaemonHandle {
  host: HostProvider
  endpoint: EndpointFile
  url: string
  port: number
  /**
   * Trigger the shutdown sequence. Idempotent. Resolves once the
   * process is ready to exit (endpoint file removed, server stopped).
   */
  shutdown(): Promise<void>
  /**
   * Resolves once teardown finishes. Fires for any shutdown trigger
   * (signal, `shutdown` RPC, host loss).
   */
  done: Promise<void>
}

export class DaemonError extends Error {
  constructor(
    message: string,
    public readonly code: 'already-running' | 'no-factory' | 'host-failed' | 'start-failed',
  ) {
    super(message)
    this.name = 'DaemonError'
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  // 1. Reject if another daemon is already serving this project.
  const status = await endpointStatus(opts.projectRoot)
  if (status === 'live') {
    const existing = await readEndpointSafe(opts.projectRoot)
    throw new DaemonError(
      `Daemon already running for ${opts.projectRoot} (pid ${existing?.pid ?? '?'}); ` +
        `send SIGINT/SIGTERM or run 'sand connect --shutdown'`,
      'already-running',
    )
  }
  if (status === 'stale' || status === 'live-recent') {
    await deleteEndpoint(opts.projectRoot, process.pid)
  }

  let bootstrapResult: Awaited<ReturnType<typeof bootstrapHost>>
  try {
    bootstrapResult = await bootstrapHost({
      hostType: opts.hostType,
      config: opts.config,
      userProvidedHostSettings: opts.userProvidedHostSettings,
    })
  } catch (e) {
    if (e instanceof BootstrapError) {
      throw new DaemonError(e.message, e.code)
    }
    throw e
  }
  const host = bootstrapResult.host

  if (host.onDisconnected) {
    host.onDisconnected((reason: string) => {
      if (expectedShutdown) {
        return
      }
      shutdownReason = 'host-lost'
      handle.shutdown().catch(() => {})
    })
  }

  // 4. Load the active `sandstone.config.ts` snapshot.
  let activeConfig: ActiveConfig | undefined
  try {
    activeConfig = await loadActiveConfigFromDisk(opts.projectRoot)
    if (!activeConfig) {
      console.error(
        `[connect] no sandstone.config.ts found in ${opts.projectRoot}; ` +
          `getActiveConfig will return an error until one is created or the watcher publishes one.`,
      )
    }
  } catch (err) {
    console.error(`[connect] failed to load sandstone.config.ts at boot:`, err)
  }

  // 5. Start the WS server. We need the bound port to write the
  // endpoint file, so we run startServer first and write the endpoint
  // after.
  const secret = generateSecret()
  const bind = opts.bind ?? '127.0.0.1'
  const port = opts.port ?? 0

  let buildBuffer: { line: string; ts: number }[] = []
  let testBuffer: { line: string; ts: number }[] = []
  let serverBuffer: { line: string; ts: number }[] = []
  const LOG_BUFFER_CAP = 1000

  let rebuildState: RebuildState | undefined

  let watcherEntry: { status: WatcherStatus; ws: Bun.ServerWebSocket<WsData> } | null = null

  const pushTo = (target: 'build' | 'test' | 'server') => (entries: { line: string; ts: number }[]) => {
    const buf = target === 'server' ? serverBuffer : target === 'test' ? testBuffer : buildBuffer
    buf.push(...entries)
    const overflow = buf.length - LOG_BUFFER_CAP
    if (overflow > 0) buf.splice(0, overflow)
  }

  if (host.capabilities.has(Capability.AttachLog) && host.attachLog) {
    try {
      await host.attachLog((lines) => {
        if (lines.length === 0) return
        pushTo('server')(lines.map((line) => ({ line, ts: Date.now() })))
      })
    } catch (err) {
      console.error(`[connect] failed to attach host log for server-log buffer:`, err)
    }
  }

  const running = startServer({
    host,
    secret,
    bind,
    port,
    onShutdown: async () => {
      shutdownReason = 'shutdown-rpc'
      handle.shutdown().catch(() => {})
    },
    getActiveConfig: () => activeConfig,
    setActiveConfig: (cfg) => {
      activeConfig = cfg
    },
    setRebuildState: (state) => {
      rebuildState = state
    },
    getRebuildState: () => rebuildState,
    getExpectedShutdown,
    setWatcherStatus: (status: WatcherStatus, ws: Bun.ServerWebSocket<WsData> | undefined) => {
      watcherEntry = ws ? { status, ws } : null
    },
    getWatcherStatus: () => watcherEntry?.status ?? null,
    appendLogLines: (entries, target) => pushTo(target)(entries),
    readLogBuffer: (target, { tail, maxLines, range, since, until } = {}) => {
      const buf = target === 'server' ? serverBuffer : target === 'test' ? testBuffer : buildBuffer
      const totalLines = buf.length
      const nowMs = Date.now()

      // 1. Time filter: `since`/`until` are seconds-relative-to-now
      //    (e.g. `since: 300` = "the last 5 minutes"). Convert to ms
      //    boundaries against the line's `ts`. `null` = no filter.
      const sinceMs = since != null ? nowMs - since * 1000 : null
      const untilMs = until != null ? nowMs - until * 1000 : null
      const timeFiltered = (sinceMs !== null || untilMs !== null)
        ? buf.filter((e) => {
          if (sinceMs !== null && e.ts < sinceMs) return false
          if (untilMs !== null && e.ts > untilMs) return false
          return true
        })
        : buf

      // 2. Range filter: `0` = most recent entry in the (possibly
      //    time-filtered) buffer. Negative counts from end.
      let selected = timeFiltered
      const matchedLines = selected.length
      if (range) {
        const { from, to } = range
        // Normalise to absolute positions relative to `selected`.
        // `pos = (length - 1) - id` for ID where `0` = newest.
        const len = selected.length
        const startIdx = len - 1 - (from < 0 ? len + from : Math.min(from, len - 1))
        const endIdx = len - 1 - (to < 0 ? len + to : Math.min(to, len - 1))
        const lo = Math.max(0, Math.min(startIdx, endIdx))
        const hi = Math.min(len - 1, Math.max(startIdx, endIdx))
        selected = selected.slice(lo, hi + 1)
      }

      // 3. `tail`/`maxLines`: cap the final slice.
      const want = tail ?? maxLines ?? 200
      const truncated = selected.length > want
      const lines = truncated ? selected.slice(-want) : selected

      return {
        lines: lines.map((e) => e.line),
        totalLines,
        matchedLines,
        oldestTs: lines[0] ? new Date(lines[0].ts).toISOString() : null,
        newestTs: lines[lines.length - 1] ? new Date(lines[lines.length - 1].ts).toISOString() : null,
        truncated,
      }
    },
  })

  // 5. Write the endpoint file. Use the bound port (resolved by Bun).
  const endpoint: EndpointFile = {
    version: 1,
    url: running.url,
    secret,
    hostType: host.type,
    displayName: host.displayName,
    capabilities: capabilitiesToRecord(host.capabilities),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot: opts.projectRoot,
    bind,
    port: running.port,
  }
  await writeEndpoint(opts.projectRoot, endpoint)

  // 6. Register signal handlers.
  let shuttingDown = false
  let shutdownReason: 'signal' | 'shutdown-rpc' | 'host-lost' = 'signal'
  let resolveDone!: () => void
  const done = new Promise<void>((r) => {
    resolveDone = r
  })
  const handle: DaemonHandle = {
    host,
    endpoint,
    url: running.url,
    port: running.port,
    done,
    async shutdown() {
      if (shuttingDown) return
      shuttingDown = true
      try {
        await teardown(
          host,
          () => running.server.stop(),
          (event, data) => running.broadcast(event, data),
          endpoint,
          shutdownReason,
          host.type === 'integrated',
        )
      } finally {
        resolveDone()
      }
    },
  }

  const onSignal = (sig: NodeJS.Signals) => {
    console.error(`\n[connect] received ${sig}, shutting down...`)
    shutdownReason = 'signal'
    handle.shutdown().catch(() => {})
  }
  try {
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    if (process.platform === 'win32') {
      process.on('SIGBREAK', onSignal as (s: NodeJS.Signals) => void)
    }
    process.on('uncaughtException', (err, origin) => {
      console.error(`[daemon] uncaughtException: ${err.message}\n${err.stack ?? '<no stack>'}\n  origin=${typeof origin === 'string' ? origin : 'unknown'}`)
    })
    process.on('unhandledRejection', (reason) => {
      const err = reason instanceof Error ? reason : new Error(String(reason))
      console.error(`[daemon] unhandledRejection: ${err.message}\n${err.stack ?? '<no stack>'}`)
    })
  } catch (err) {
    console.error('[connect] failed to register signal handlers:', err)
    try {
      await deleteEndpoint(opts.projectRoot, process.pid)
    } catch (cleanupErr) {
      console.error('[connect] endpoint cleanup after signal-register failure failed:', cleanupErr)
    }
    throw err
  }

  return handle
}

async function teardown(
  host: HostProvider,
  stopWS: () => Promise<void>,
  broadcast: (event: string, data: unknown) => void,
  endpoint: EndpointFile,
  reason: 'signal' | 'shutdown-rpc' | 'host-lost',
  ownsServer: boolean,
): Promise<void> {
  broadcast('daemonShutdown', { reason })
  await new Promise<void>((r) => setTimeout(r, 100))
  if (ownsServer && host.stopServer) {
    try {
      await host.stopServer()
    } catch (err) {
      console.error(`[connect] host stopServer failed:`, err)
    }
  }
  try {
    await deleteEndpoint(endpoint.projectRoot, endpoint.pid)
  } catch (err) {
    console.error(`[connect] endpoint delete failed:`, err)
  }
  try {
    await stopWS()
  } catch (err) {
    console.error(`[connect] ws server stop failed:`, err)
  }
  try {
    await host.disconnect()
  } catch (err) {
    console.error(`[connect] host disconnect failed:`, err)
  }
  console.error(`[connect] shutdown complete (${reason})`)
}

async function readEndpointSafe(projectRoot: string) {
  try {
    const path = endpointPath(projectRoot)
    const raw = await Bun.file(path).text()
    return JSON.parse(raw) as { pid: number }
  } catch {
    return null
  }
}