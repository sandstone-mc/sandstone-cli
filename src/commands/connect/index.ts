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
  // For 1 type, accept the flat shape (legacy back-compat). Either way
  // we shape-detect the input — keyed composite, or flat single.
  const perHostConfig = normalizeConfig(rawConfig, hostTypes, projectRoot)

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
 * Shape-detect the `--host-config` JSON and split into per-host-type
 * entries. Two shapes are accepted:
 *
 *   - **Flat** (single-host-type or "this is my one provider's config"):
 *     `{"host":"...","port":...,...}` — the keys are config fields.
 *   - **Composite** (N host types, keyed by host type):
 *     `{"ssh":{...},"rcon":{...}}` — top-level keys are host type names.
 *
 * Detection: if any top-level key is a known `HostType`, treat the
 * object as composite. Anything else is treated as a single config
 * assigned to the only requested `--host-type`.
 *
 * Errors out clearly when:
 *   - Composite shape is used but `--host-type` lists only one
 *     provider AND the composite key doesn't match that provider
 *     (caller almost certainly meant `--host-type <other>`).
 *   - Single-host-type with composite shape AND the key matches →
 *     silently accept (caller wrote the composite shape out of habit).
 */
function normalizeConfig(
  raw: HostConfigInput,
  hostTypes: HostType[],
  projectRoot: string,
): Partial<Record<HostType, HostConfigInput>> {
  if (!isObject(raw)) {
    console.error(
      chalk`{red Error:} --host-config must be a JSON object`,
    )
    process.exit(2)
  }
  const keys = Object.keys(raw)
  const isCompositeShape = keys.some((k) => KNOWN_HOST_TYPES.has(k as HostType))

  if (isCompositeShape) {
    return normalizeCompositeShape(raw as Record<string, unknown>, hostTypes, projectRoot)
  }
  // Flat shape: must be a single-host-type call.
  if (hostTypes.length !== 1) {
    console.error(
      chalk`{red Error:} --host-config is a flat config but --host-type lists multiple providers ` +
        `(${hostTypes.join(', ')}). Pass a composite config: ` +
        `'{"${hostTypes[0]}":{...},"${hostTypes[1] ?? '?'}":{...},...}'`,
    )
    process.exit(2)
  }
  return normalizeSingleFlat(raw, hostTypes[0]!, projectRoot)
}

/** Apply per-host defaults (projectRoot, verbose) to a flat config. */
function normalizeSingleFlat(
  raw: Record<string, unknown>,
  type: HostType,
  projectRoot: string,
): Partial<Record<HostType, HostConfigInput>> {
  const cfg = { ...raw, verbose: true } as HostConfigInput
  if (cfg.projectRoot === undefined) cfg.projectRoot = projectRoot
  return { [type]: cfg }
}

/** Validate the keyed composite shape and apply per-host defaults. */
function normalizeCompositeShape(
  keyed: Record<string, unknown>,
  hostTypes: HostType[],
  projectRoot: string,
): Partial<Record<HostType, HostConfigInput>> {
  const out: Partial<Record<HostType, HostConfigInput>> = {}
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

// `normalizeCompositeConfig` was folded into `normalizeConfig` above —
// the shape-detect happens in one place now.

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