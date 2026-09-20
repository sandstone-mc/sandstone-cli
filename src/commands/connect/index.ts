/**
 * `sand connect` — long-lived host daemon over WebSocket.
 *
 * Two modes:
 *   - Default: spawn a daemon that hosts the chosen provider(s) and listens
 *     on a local WS port. Endpoint file written to
 *     `<projectRoot>/.sandstone/connect.url`.
 *   - `--shutdown`: read the endpoint file and send the daemon the
 *     `shutdown` RPC. Exits 0 on success, 1 if the file is missing or
 *     the daemon can't be reached.
 *
 * `--host-type` accepts a single provider (`--host-type integrated`) or
 * multiple comma-separated providers (`--host-type ssh,rcon`). With >1
 * types, `--host-config` must be a keyed map: `'{"ssh":{...},"rcon":{...}}'`.
 * With 1 type, the flat shape is accepted for back-compat.
 */

import { resolve } from 'node:path'
import { connect as openClient } from './client.js'
import { startDaemon } from './daemon.js'
import { readEndpoint, pidAlive } from './endpoint-file.js'
import { KNOWN_HOST_TYPES, type HostConfigInput, type HostType } from '../../hosts/types.js'
import { printSplash } from '../../utils/index.js'
import chalk from 'chalk-template'

export interface ConnectCommandOptions {
  /** `--host-type <type>` or `--host-type <t1>,<t2>` */
  hostType?: string
  /** `--host-config <json>` (flat single or keyed composite map) */
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

  // Parse + validate --host-type (comma-separated list).
  // `--host-type` defaults to the integrated+rcon composite — the only
  // built-in default. `--host-config` / `--host-config-file` default
  // to a minimal map keyed by host type. Anything else requires an
  // explicit flag.
  const hostTypes = parseHostTypes(opts.hostType)
  if (hostTypes.length === 0) {
    console.error(
      chalk`{red Error:} --host-type is required when not using the default (one of: ssh, rcon, ftp, local-client, integrated, mcsmanager-login)`,
    )
    process.exit(2)
  }
  for (const t of hostTypes) {
    if (!KNOWN_HOST_TYPES.has(t)) {
      console.error(chalk`{red Error:} Unknown --host-type '${t}'`)
      process.exit(2)
    }
  }

  // Auto-include `local-client` is handled inside startDaemon → bootstrap
  // once the project config has been loaded. Forward whether the user
  // passed any host-setting flag so the bootstrap knows when to skip.
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

  // Default to a minimal composite config when --host-config is
  // omitted: each requested member gets `{}` and the daemon's auto-
  // config block fills in host/port/password/sandstoneVersion/etc.
  let rawConfig: HostConfigInput
  if (opts.hostConfig || opts.hostConfigFile) {
    rawConfig = await loadHostConfig(opts)
  } else {
    rawConfig = Object.fromEntries(hostTypes.map((t) => [t, {}])) as HostConfigInput
  }
  const port = opts.port !== undefined ? Number(opts.port) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(chalk`{red Error:} --port must be an integer in [0, 65535]`)
    process.exit(2)
  }

  // For >1 host types, --host-config must be a keyed map of HostType → config.
  // For 1 type, accept the flat shape (legacy back-compat).
  const perHostConfig = hostTypes.length === 1
    ? normalizeSingleConfig(rawConfig, hostTypes[0]!, projectRoot)
    : normalizeCompositeConfig(rawConfig, hostTypes, projectRoot)

  const handle = await startDaemon({
    hostTypes,
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

/** Default host types for a local-dev daemon: integrated + rcon. */
export const DEFAULT_HOST_TYPES: readonly HostType[] = ['rcon', 'integrated']

function parseHostTypes(raw: string | undefined): HostType[] {
  // Default to a composite daemon — the typical local dev setup:
  // integrated spins up the Fabric server, rcon speaks its console.
  if (!raw) return [...DEFAULT_HOST_TYPES]
  const types = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // Dedup while preserving order.
  return Array.from(new Set(types)) as HostType[]
}

/**
 * Accept the flat single-config shape used when `--host-type` lists one
 * provider. Inject `projectRoot` + `verbose` defaults so callers can
 * omit them.
 */
function normalizeSingleConfig(
  raw: HostConfigInput,
  type: HostType,
  projectRoot: string,
): Partial<Record<HostType, HostConfigInput>> {
  const cfg = { ...raw }
  if (cfg.projectRoot === undefined) cfg.projectRoot = projectRoot
  cfg.verbose = true
  return { [type]: cfg } as Partial<Record<HostType, HostConfigInput>>
}

/**
 * Accept the keyed composite shape used when `--host-type` lists multiple
 * providers. Each member's config is normalized independently.
 */
function normalizeCompositeConfig(
  raw: HostConfigInput,
  hostTypes: HostType[],
  projectRoot: string,
): Partial<Record<HostType, HostConfigInput>> {
  if (!isObject(raw)) {
    console.error(
      chalk`{red Error:} With multiple --host-type values, --host-config must be a JSON object keyed by type (e.g. '{"ssh":{...},"rcon":{...}}')`,
    )
    process.exit(2)
  }
  const out: Partial<Record<HostType, HostConfigInput>> = {}
  const keyed = raw as Record<string, unknown>
  for (const type of hostTypes) {
    const member = keyed[type]
    if (!member) {
      console.error(chalk`{red Error:} --host-config is missing config for '${type}'`)
      process.exit(2)
    }
    if (!isObject(member)) {
      console.error(chalk`{red Error:} --host-config['${type}'] must be a JSON object`)
      process.exit(2)
    }
    const cfg = { ...member, verbose: true } as HostConfigInput
    if (cfg.projectRoot === undefined) cfg.projectRoot = projectRoot
    out[type] = cfg
  }
  return out
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

async function loadHostConfig(opts: ConnectCommandOptions): Promise<HostConfigInput> {
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