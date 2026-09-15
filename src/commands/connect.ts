/**
 * `sand connect` — long-lived host daemon over WebSocket.
 *
 * Two modes:
 *   - Default: spawn a daemon that hosts the chosen provider and listens
 *     on a local WS port. Endpoint file written to
 *     `<projectRoot>/.sandstone/connect.url`.
 *   - `--shutdown`: read the endpoint file and send the daemon the
 *     `shutdown` RPC. Exits 0 on success, 1 if the file is missing or
 *     the daemon can't be reached.
 */

import { resolve } from 'node:path'
import { connect as openClient } from '../connect/client.js'
import { startDaemon, DaemonError } from '../connect/daemon.js'
import { readEndpoint, pidAlive } from '../connect/endpoint-file.js'
import type { HostType } from '../hosts/types.js'
import chalk from 'chalk-template'

export interface ConnectCommandOptions {
  /** `--host-type <type>` */
  hostType?: string
  /** `--host-config <json>` */
  hostConfig?: string
  /** `--host-config-file <path>` */
  hostConfigFile?: string
  /** `--bind <addr>` */
  bind?: string
  /** `--port <n>` */
  port?: string
  /** `--shutdown` flag */
  shutdown?: boolean
  /** `--path <path>` (re-used from BuildOptions) — project root. */
  path: string
}

/** Detect sensitive keys in --host-config so we can warn the user. */
const SENSITIVE_KEYS = ['privateKey', 'password', 'cookie', 'token']

export async function connectCommand(opts: ConnectCommandOptions): Promise<void> {
  const projectRoot = resolve(opts.path)

  if (opts.shutdown) {
    await runShutdown(projectRoot)
    return
  }

  // Validate the daemon-start flags.
  const hostType = opts.hostType as HostType | undefined
  if (!hostType) {
    console.error(chalk`{red Error:} --host-type is required (one of: ssh, rcon, ftp, local-client, integrated, mcsmanager-login)`)
    process.exit(2)
  }
  const knownTypes = new Set<HostType>(['ssh', 'rcon', 'ftp', 'local-client', 'integrated', 'mcsmanager-login'])
  if (!knownTypes.has(hostType)) {
    console.error(chalk`{red Error:} Unknown --host-type '${hostType}'`)
    process.exit(2)
  }
  if (!opts.hostConfig && !opts.hostConfigFile) {
    console.error(chalk`{red Error:} Either --host-config <json> or --host-config-file <path> is required`)
    process.exit(2)
  }
  if (opts.hostConfig && opts.hostConfigFile) {
    console.error(chalk`{red Error:} Pass either --host-config or --host-config-file, not both`)
    process.exit(2)
  }

  // Sensitive-key warning when the JSON is passed inline.
  if (opts.hostConfig) {
    const lowered = opts.hostConfig.toLowerCase()
    const hit = SENSITIVE_KEYS.find((k) => lowered.includes(k.toLowerCase()))
    if (hit) {
      console.error(
        chalk`{yellow Warning:} --host-config contains '${hit}'; this is visible in \`ps aux\`. ` +
          `Prefer --host-config-file with \`chmod 0600\`.`,
      )
    }
  }

  const hostConfig = await loadHostConfig(opts)
  // Most providers benefit from knowing the project root (integrated
  // requires it). Inject it from the --path flag when not already set.
  if (typeof (hostConfig as { projectRoot?: unknown }).projectRoot !== 'string') {
    ;(hostConfig as Record<string, unknown>).projectRoot = projectRoot
  }
  const port = opts.port !== undefined ? Number(opts.port) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(chalk`{red Error:} --port must be an integer in [0, 65535]`)
    process.exit(2)
  }

  const handle = await startDaemon({
    hostType,
    hostConfig,
    projectRoot,
    bind: opts.bind,
    port,
  })

  // Print a single line with the URL + pid so the user knows where to
  // connect. Don't print the secret — it lives in the endpoint file.
  console.log(
    chalk`{cyan [connect]} listening on {bold ${handle.url}} (pid ${handle.endpoint.pid})`,
  )
  console.log(chalk`{cyan [connect]} endpoint file: ${projectRoot + '/.sandstone/connect.url'}`)

  // Keep the process alive until shutdown completes, then exit. The
  // signal handlers and the `shutdown` RPC both call
  // `handle.shutdown()` which resolves `handle.done` — at which point
  // we exit cleanly. process.exit is necessary because Bun otherwise
  // keeps the process alive on lingering handles (subprocess stdio,
  // etc.).
  await handle.done
  process.exit(0)
}

async function loadHostConfig(opts: ConnectCommandOptions): Promise<unknown> {
  if (opts.hostConfigFile) {
    const raw = await Bun.file(opts.hostConfigFile).text()
    return JSON.parse(raw)
  }
  // opts.hostConfig is guaranteed to be defined by the caller-side check.
  return JSON.parse(opts.hostConfig!)
}

async function runShutdown(projectRoot: string): Promise<void> {
  const endpoint = await readEndpoint(projectRoot)
  if (!endpoint) {
    console.error(chalk`{red Error:} No endpoint file at ${projectRoot}/.sandstone/connect.url — no daemon to shut down`)
    process.exit(1)
  }
  if (!(await pidAlive(endpoint.pid))) {
    console.error(chalk`{red Error:} Endpoint file references pid ${endpoint.pid} which is not alive`)
    process.exit(1)
  }
  try {
    const client = await openClient({ endpoint })
    await client.shutdown()
    client.close()
    console.log(chalk`{cyan [connect]} shutdown sent to daemon (pid ${endpoint.pid})`)
  } catch (err) {
    console.error(chalk`{red Error:} Failed to reach daemon: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}