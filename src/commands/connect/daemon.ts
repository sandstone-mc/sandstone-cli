/**
 * Daemon orchestrator.
 *
 * Lifecycle:
 *   1. Validate the project's endpoint file isn't already serving a live
 *      daemon (pidAlive + age check).
 *   2. Instantiate the requested HostProvider via the registry.
 *   3. Start the WS server (host not yet connected — server is
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
 * The shutdown sequence is idempotent — multiple triggers (signal +
 * RPC + another signal) collapse to one execution.
 */

import chalk from 'chalk-template'
import { capabilitiesToRecord, Capability, type HostConfigInput, type HostProvider, type HostType } from '../../hosts/types.js'
import { BootstrapError, bootstrapHosts } from './bootstrap.js'
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
import { startServer } from './server.js'
import type { RebuildState, WatcherStatus } from './rpc.js'
import {
  deleteEndpoint,
  endpointPath,
  endpointStatus,
  generateSecret,
  pidAlive,
  writeEndpoint,
  type EndpointFile,
} from './endpoint-file.js'

export interface DaemonOptions {
  /** The single host type for this daemon. */
  hostType: HostType
  /** Config for the host type above. */
  perHostConfig: Partial<Record<HostType, HostConfigInput>>
  projectRoot: string
  /** Bind address. Default `127.0.0.1` (loopback only — never LAN). */
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
  /** Returns the running server's bound port (post-bind). */
  port: number
  /**
   * Trigger the shutdown sequence. Idempotent. Resolves once the
   * process is ready to exit (endpoint file removed, server stopped).
   * Does NOT call `process.exit` — the orchestrator decides whether to
   * exit (e.g. the CLI exits normally; tests don't exit).
   */
  shutdown(): Promise<void>
  /**
   * Resolves once the daemon has begun its shutdown sequence (whether
   * triggered by signal or by the `shutdown` RPC). Use this to await
   * teardown completion before calling `process.exit`.
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

/**
 * Start the daemon. Returns once the server is listening and the
 * endpoint file is on disk. Caller is responsible for keeping the
 * process alive (e.g. awaiting a long-lived promise) and eventually
 * triggering `handle.shutdown()`.
 */
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
    // Stale (pid dead + old file) → safe to clear. live-recent is
    // ambiguous; clear it too — the new daemon will win. Pass our pid
    // so deleteEndpoint refuses to remove a file owned by a still-live
    // different daemon (the previous owner's pid is gone in 'stale'
    // and usually gone in 'live-recent', but be defensive).
    await deleteEndpoint(opts.projectRoot, process.pid)
  }

  // 2. Instantiate + connect + start via the shared bootstrap. The same
  // path runs in `sand run` direct mode — both must agree on defaults
  // (sandstone version, RCON port/password auto-derivation) and on
  // member lifecycle order.
  console.error(`[daemon-trace] step 1: bootstrapping host=${opts.hostType}`)
  let bootstrapResult: Awaited<ReturnType<typeof bootstrapHosts>>
  try {
    bootstrapResult = await bootstrapHosts({
      hostType: opts.hostType,
      perHostConfig: opts.perHostConfig,
      userProvidedHostSettings: opts.userProvidedHostSettings,
    })
    console.error(`[daemon-trace] step 1 done: bootstrap returned`)
  } catch (e) {
    if (e instanceof BootstrapError) {
      throw new DaemonError(e.message, e.code)
    }
    throw e
  }
  const host = bootstrapResult.host
  const members = bootstrapResult.members
  // `integrated` is the only host type whose lifecycle the daemon
  // actually owns (it spawns and supervises the MC JVM). For every
  // other provider — ssh, ftp, rcon, local-client, mcsmanager-login
  // — the daemon just connects to a server the user started
  // externally. Threaded into `teardown()` so handle.shutdown()
  // knows whether it's allowed to call host.stopServer(). Without
  // this gate, an `onDisconnected` blip on any member of e.g.
  // `[ftp, rcon]` would route stopServer to the rcon member and
  // `stop` a server the daemon doesn't own — which is what used to
  // kill the harness MC mid-suite.
  const ownsServer = members.some((m) => m.type === 'integrated')

  // 6b. Watch each member for unexpected liveness loss. If any member
  // dies (JVM exit, RCON socket close, SSH connection drop, etc.), shut
  // the whole daemon down — half a composite is worse than no daemon.
  // `disconnect()` on the host clears its handler set, so we don't
  // need to track unsubscribers.
  //
  // Hosts can declare a disconnect as expected by setting
  // `m.shuttingDown = true` before initiating shutdown (e.g.
  // `integrated.stopServer` before SIGTERM, `rcon.executeRawCommand('stop')`
  // before RCON's self-disconnect). When set, the watcher no-ops so a
  // restart cycle can cycle one member without tearing the daemon down.
  for (const m of members) {
    if (!m.onDisconnected) continue
    m.onDisconnected((reason: string) => {
      if (expectedShutdown) {
        console.error(`[connect] member '${m.type}' disconnected (${reason}) — expected shutdown (self-initiated), daemon stays up`)
        // Don't clear `expectedShutdown` here — multiple members can
        // disconnect during one cycle (e.g. rcon + integrated in a
        // composite). Cleared at the START of the next cycle instead.
        return
      }
      shutdownReason = 'host-lost'
      console.error(`[connect] member '${m.type}' disconnected (${reason}) — shutting down`)
      void handle.shutdown()
    })
  }

  // 4. Load the active `sandstone.config.ts` snapshot. Best-effort: if
  // the project has no config (yet), leave it undefined and let the
  // dispatch handlers surface a clear "not a Sandstone project" error.
  // The watcher will publish a snapshot over WS shortly after it
  // connects, so an undefined boot-time value is fine — it just means
  // `getActiveConfig` answers "no active config" until then.
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

  // Two bounded circular buffers of log lines, one per stream target.
  // Each entry carries its arrival timestamp so the matching read
  // RPC can filter by time. The buffers are the canonical sources —
  // any on-disk log files are only kept as a side effect for humans
  // tailing them directly.
  //
  // - `buildBuffer`: pushed by `sand watch` via `publishLog`.
  // - `testBuffer`: reserved for the future test runner; nothing
  //   pushes to it yet, but the shape matches so MCP can offer the
  //   same filtering on `readTestLog`.
  // - `serverBuffer`: the host's stdout. The daemon subscribes to its
  //   own host's `attachLog` at boot (below) and pushes every line
  //   here, so `readServerLog` works without a watcher and without
  //   reading the on-disk log file.
  let buildBuffer: { line: string; ts: number }[] = []
  let testBuffer: { line: string; ts: number }[] = []
  let serverBuffer: { line: string; ts: number }[] = []
  const LOG_BUFFER_CAP = 1000

  // Latest rebuild state pushed by the watcher. `undefined` until the
  // first `publishRebuild` lands. Read by MCP's `sandstone://rebuild-state`
  // resource handler; updated by the watcher on every build start/finish.
  let rebuildState: RebuildState | undefined

  // Current watcher status. `null` until `publishWatcherStatus` lands;
  // flipped to `connected: false` by `handleSessionClose` (in dispatch.ts)
  // when the watcher's WS session closes. The actual ws tracking lives
  // in dispatch.ts so the session-close handler can match it without
  // a round-trip.
  let watcherStatus: WatcherStatus | null = null

  const pushTo = (target: 'build' | 'test' | 'server') => (entries: { line: string; ts: number }[]) => {
    // Source stamps each entry with the emit timestamp. Daemon stores
    // verbatim — no re-stamping on receipt, so the value reflects
    // "when the event happened" rather than "when the network packet
    // landed".
    const buf = target === 'server' ? serverBuffer : target === 'test' ? testBuffer : buildBuffer
    buf.push(...entries)
    const overflow = buf.length - LOG_BUFFER_CAP
    if (overflow > 0) buf.splice(0, overflow)
  }

  // Daemon-owned subscription to the host's stdout. Pushes every
  // emitted chunk into `serverBuffer` so `readServerLog` works without
  // a watcher and without reading the on-disk log file. Skipped when
  // the host doesn't expose `attachLog` (e.g. some composite members
  // that delegate to another member's stream). The returned
  // subscription's `unattach` is fire-and-forget — the daemon never
  // detaches during its lifetime (lifecycle ends at process exit).
  if (host.capabilities.has(Capability.AttachLog) && host.attachLog) {
    try {
      // The daemon holds this subscription open for its entire
      // lifetime — calling `unattach()` would immediately remove the
      // handler we just added. The subscription dies with the process.
      await host.attachLog((lines) => {
        if (lines.length === 0) return
        pushTo('server')(lines.map((line) => ({ line, ts: Date.now() })))
      })
    } catch (err) {
      console.error(`[connect] failed to attach host log for server-log buffer:`, err)
    }
  }

  // Race the server start against an outer timeout — if Bun.serve
  // fails (port in use), we'd otherwise hang on `server.port` access.
  console.error(`[daemon-trace] step 5: starting WS server`)
  const running = startServer({
    host,
    secret,
    bind,
    port,
    onShutdown: () => {
      // The server signals us via this callback when a client sends
      // the `shutdown` RPC. Kick off the same teardown as a signal
      // would, but record the actual reason.
      shutdownReason = 'shutdown-rpc'
      void handle.shutdown()
    },
    // Closure captures `activeConfig` by reference — the `let`
    // declaration above makes it mutable. Future `publishConfig` calls
    // (from the watcher) reassign it and all subsequent dispatch
    // contexts see the new value via the same closure.
    getActiveConfig: () => activeConfig,
    setActiveConfig: (cfg) => {
      activeConfig = cfg
    },
    // Closure captures `rebuildState` by reference — mutable so future
    // `publishRebuild` calls reassign it and all subsequent dispatch
    // contexts see the new value.
    setRebuildState: (state) => {
      rebuildState = state
    },
    getRebuildState: () => rebuildState,
    getExpectedShutdown,
    // Watcher passes ctx.ws as the second arg so dispatch.ts can track
    // which session is the watcher (used by `handleSessionClose` to
    // flip `connected: false` on disconnect).
    setWatcherStatus: (status: WatcherStatus, _ws: unknown) => {
      watcherStatus = status
    },
    getWatcherStatus: () => watcherStatus,
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
  console.error(`[daemon-trace] step 4: sandstone.config snapshot loaded=${!!activeConfig}`)
  const handle: DaemonHandle = {
    host,
    endpoint,
    url: running.url,
    port: running.port,
    done,
    async shutdown() {
      if (shuttingDown) return
      shuttingDown = true
      // `server.stop` must keep its `this` — Bun's stop throws
      // ERR_INVALID_THIS otherwise.
      try {
        await teardown(
          host,
          () => running.server.stop(),
          (event, data) => running.broadcast(event, data),
          endpoint,
          shutdownReason,
          ownsServer,
        )
      } finally {
        // resolveDone MUST run even if teardown throws — otherwise the
        // caller's `await handle.done` hangs forever and process.exit(0)
        // never fires, leaving the daemon (and the endpoint) alive
        // indefinitely. deleteEndpoint already ran inside teardown if it
        // got that far; this is the safety net for the throw case.
        resolveDone()
      }
    },
  }

  const onSignal = (sig: NodeJS.Signals) => {
    console.error(`\n[connect] received ${sig}, shutting down...`)
    shutdownReason = 'signal'
    void handle.shutdown()
  }
  try {
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    if (process.platform === 'win32') {
      process.on('SIGBREAK', onSignal as (s: NodeJS.Signals) => void)
    }
    // Diagnostic: surface uncaught exceptions with their source so
    // we can find which stream/socket is dropping an `error` event
    // before crashing the process. Logs to stderr (already mirrored
    // to the parent's test log when running under the harness).
    process.on('uncaughtException', (err, origin) => {
      console.error(`[daemon-trace] uncaughtException: ${err.message}\n${err.stack ?? '<no stack>'}\n  origin=${typeof origin === 'string' ? origin : 'unknown'}`)
    })
    process.on('unhandledRejection', (reason) => {
      const err = reason instanceof Error ? reason : new Error(String(reason))
      console.error(`[daemon-trace] unhandledRejection: ${err.message}\n${err.stack ?? '<no stack>'}`)
    })
  } catch (err) {
    // Signal registration failed (extremely unlikely on POSIX). Clean up
    // the endpoint and re-throw so the caller knows startup failed —
    // leaving the file behind with a half-initialized daemon would be
    // worse than a clean error.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function teardown(
  host: HostProvider,
  stopWS: () => Promise<void>,
  broadcast: (event: string, data: unknown) => void,
  endpoint: EndpointFile,
  reason: 'signal' | 'shutdown-rpc' | 'host-lost',
  ownsServer: boolean,
): Promise<void> {
  // Tell every open client we're shutting down BEFORE we touch the WS
  // transport. Clients use this signal to flush pending state (close
  // subscriptions, log a goodbye line) before the socket is yanked.
  // The 100ms grace is short enough to feel instant but long enough
  // for the event envelope to land in the client. Any client that's
  // not actively reading (idle watcher) still benefits — once they do
  // read, they see `daemonShutdown` and exit instead of treating the
  // close as an error.
  broadcast('daemonShutdown', { reason })
  await new Promise<void>((r) => setTimeout(r, 100))
  // Soft-stop the underlying server first so it gets a chance to save
  // worlds + broadcast goodbye before we yank the transport. For
  // composite `[rcon, integrated]` this dispatches to the rcon member,
  // which sends `stop` via RCON. For single integrated, it sends
  // SIGTERM + waits.
  //
  // Only call this when the daemon actually owns the server — i.e.
  // `integrated` is among the members. Everything else (ssh, ftp,
  // rcon, local-client, mcsmanager-login) is connection-only and
  // points at user-started servers; `stop`ing them would be
  // destructive.
  if (ownsServer && host.stopServer) {
    try {
      await host.stopServer()
    } catch (err) {
      console.error(`[connect] host stopServer failed:`, err)
    }
  }
  // Delete the endpoint file BEFORE the rest of teardown. Once the JVM
  // is dead (above), the daemon's role as "the daemon for this project"
  // is over — even if `stopWS()` or `host.disconnect()` hang below on
  // a stuck Bun.spawn stream or stalled WS handshake, the endpoint is
  // already gone so the next `sand connect` won't see this dying
  // daemon as live. Pass our pid so deleteEndpoint refuses to remove
  // a file owned by a different daemon (see endpoint-file.ts).
  try {
    await deleteEndpoint(endpoint.projectRoot, endpoint.pid)
  } catch (err) {
    console.error(`[connect] endpoint delete failed:`, err)
  }
  // Now tear down the WS server and disconnect the host. Either may
  // hang on stuck Bun internals; the endpoint is already gone, so the
  // worst case is the process not exiting promptly, NOT an orphan file.
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
  // Surface the reason in stderr for log scrapers. Wrapped in
  // try/catch so a closed-stdout EPIPE on this write can't propagate
  // out of teardown and leave the caller's `await handle.done` hanging.
  try {
    console.error(`[connect] shutdown complete (${reason})`)
  } catch {
    // ignore
  }
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

// `pidAlive` is re-exported here so callers can reuse the import path
// from `daemon.ts` if they want to test the "already running" branch.
export { pidAlive }