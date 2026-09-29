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
 *
 * `--host-type` accepts a single provider (`--host-type integrated`).
 * Defaults to `integrated` when omitted. `--host-config` is the
 * provider's JSON config; `--host-config-file` reads it from disk.
 */

import { resolve } from 'node:path'
import { connect as openClient } from './client.js'
import { startDaemon } from './daemon.js'
import { readEndpoint, pidAlive } from './endpoint-file.js'
import { KNOWN_HOST_TYPES, type HostConfigInput, type HostType } from '../../hosts/types.js'
import { printSplash } from '../../utils/index.js'
import chalk from 'chalk-template'

export interface ConnectCommandOptions {
  /** `--host-type <type>` — single provider. */
  hostType?: string
  /** `--host-config <json>` (flat single config) */
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

  // Banner — only the long-running daemon command gets the splash.
  printSplash()

  // Parse --host-type. Default to `integrated` when omitted. Reject
  // multi-host-type values — composite daemons are gone.
  const hostType = parseHostType(opts.hostType)
  if (!KNOWN_HOST_TYPES.has(hostType)) {
    console.error(
      chalk`{red Error:} Unknown --host-type '${hostType}' (one of: ssh, ftp, local-client, integrated, mcsmanager-login)`,
    )
    process.exit(2)
  }

  // Forward whether the user passed any host-setting flag so the
  // bootstrap knows when to skip auto-`local-client` augmentation.
  const userProvidedHostSettings = !!opts.hostType || !!opts.hostConfig || !!opts.hostConfigFile

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

  // Read the host's config (or default to `{}`). The daemon's auto-
  // config block fills in host/port/password/sandstoneVersion/etc.
  const rawConfig = await loadHostConfig(opts)
  const perHostConfig = normalizeConfig(rawConfig, projectRoot, hostType)

  const port = opts.port !== undefined ? Number(opts.port) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(chalk`{red Error:} --port must be an integer in [0, 65535]`)
    process.exit(2)
  }

  const handle = await startDaemon({
    hostType,
    perHostConfig,
    projectRoot,
    bind: opts.bind,
    port,
    userProvidedHostSettings,
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

/** Default host type for a local-dev daemon: integrated. */
export const DEFAULT_HOST_TYPE: HostType = 'integrated'

function parseHostType(raw: string | undefined): HostType {
  // No flag → default to the local-dev daemon.
  if (!raw) return DEFAULT_HOST_TYPE
  // Multi-host-type values were a `hostType1,hostType2` string before.
  // Reject explicitly so callers don't silently get an arbitrary pick.
  if (raw.includes(',')) {
    console.error(
      chalk`{red Error:} Only one --host-type is supported, got '${raw}'. Composite daemons were removed.`,
    )
    process.exit(2)
  }
  return raw as HostType
}

/**
 * Wrap the flat host config and inject `projectRoot` + `verbose` so
 * the daemon doesn't have to re-inject these per provider.
 */
function normalizeConfig(
  raw: HostConfigInput,
  projectRoot: string,
  hostType: HostType,
): Partial<Record<HostType, HostConfigInput>> {
  if (raw === undefined || raw === null) {
    return {}
  }
  if (!isObject(raw)) {
    console.error(chalk`{red Error:} --host-config must be a JSON object`)
    process.exit(2)
  }
  const cfg = { ...raw, verbose: true } as HostConfigInput
  if (cfg.projectRoot === undefined) cfg.projectRoot = projectRoot
  return { [hostType]: cfg }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

async function loadHostConfig(opts: ConnectCommandOptions): Promise<HostConfigInput> {
  if (opts.hostConfigFile) {
    const raw = await Bun.file(opts.hostConfigFile).text()
    return JSON.parse(raw) as HostConfigInput
  }
  if (opts.hostConfig) {
    return JSON.parse(opts.hostConfig) as HostConfigInput
  }
  // No config passed — leave the bootstrap to apply defaults.
  return {} as HostConfigInput
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
