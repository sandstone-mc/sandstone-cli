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

import { getProvider } from '../hosts/registry.js'
// Side-effect import — registers every HostProvider factory. Without
// this the daemon's `getProvider()` lookup returns undefined.
import '../hosts/index.js'
import type { HostProvider, HostType } from '../hosts/types.js'
import { startServer } from './server.js'
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
  hostType: HostType
  hostConfig: unknown
  projectRoot: string
  /** Bind address. Default `127.0.0.1` (loopback only — never LAN). */
  bind?: string
  /** Bind port. `0` lets the OS pick. */
  port?: number
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
  constructor(message: string, public readonly code: 'already-running' | 'no-factory' | 'host-failed') {
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
    // ambiguous; clear it too — the new daemon will win.
    await deleteEndpoint(opts.projectRoot)
  }

  // 2. Resolve the provider factory.
  const factory = getProvider(opts.hostType)
  if (!factory) {
    throw new DaemonError(`Unknown host type: ${opts.hostType}`, 'no-factory')
  }

  // 3. Instantiate + connect the host. Long-running (integrated can
  // take 30s for Fabric install).
  let host: HostProvider
  try {
    host = factory.create(opts.hostConfig)
    await host.connect()
  } catch (e) {
    throw new DaemonError(
      `Failed to connect host '${opts.hostType}': ${e instanceof Error ? e.message : String(e)}`,
      'host-failed',
    )
  }

  // 4. Start the WS server. We need the bound port to write the
  // endpoint file, so we run startServer first and write the endpoint
  // after.
  const secret = generateSecret()
  const bind = opts.bind ?? '127.0.0.1'
  const port = opts.port ?? 0

  // Race the server start against an outer timeout — if Bun.serve
  // fails (port in use), we'd otherwise hang on `server.port` access.
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
  })

  // 5. Write the endpoint file. Use the bound port (resolved by Bun).
  const endpoint: EndpointFile = {
    version: 1,
    url: running.url,
    secret,
    hostType: host.type,
    displayName: host.displayName,
    capabilities: { ...host.capabilities },
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot: opts.projectRoot,
    bind,
    port: running.port,
  }
  await writeEndpoint(opts.projectRoot, endpoint)

  // 6. Register signal handlers.
  let shuttingDown = false
  let shutdownReason: 'signal' | 'shutdown-rpc' = 'signal'
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
      // `server.stop` must keep its `this` — Bun's stop throws
      // ERR_INVALID_THIS otherwise.
      await teardown(host, () => running.server.stop(), opts.projectRoot, shutdownReason)
      resolveDone()
    },
  }

  const onSignal = (sig: NodeJS.Signals) => {
    console.error(`\n[connect] received ${sig}, shutting down...`)
    shutdownReason = 'signal'
    void handle.shutdown()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  if (process.platform === 'win32') {
    process.on('SIGBREAK', onSignal as (s: NodeJS.Signals) => void)
  }

  return handle
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function teardown(
  host: HostProvider,
  stopServer: () => Promise<void>,
  projectRoot: string,
  reason: 'signal' | 'shutdown-rpc' | 'host-lost',
): Promise<void> {
  // Order matters: stop accepting first (server), then disconnect host,
  // then remove the endpoint file last so a new daemon doesn't try to
  // bind a port we still hold.
  try {
    await stopServer()
  } catch (err) {
    console.error(`[connect] server stop failed:`, err)
  }
  try {
    await host.disconnect()
  } catch (err) {
    console.error(`[connect] host disconnect failed:`, err)
  }
  try {
    await deleteEndpoint(projectRoot)
  } catch (err) {
    console.error(`[connect] endpoint delete failed:`, err)
  }
  // Surface the reason in stderr for log scrapers.
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

// `pidAlive` is re-exported here so callers can reuse the import path
// from `daemon.ts` if they want to test the "already running" branch.
export { pidAlive }