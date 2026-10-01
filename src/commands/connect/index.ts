import { resolve } from 'node:path'
import { connect as openClient } from './client.js'
import { startDaemon } from './daemon.js'
import { readEndpoint, pidAlive } from './endpoint-file.js'
import { isObject } from '../../utils/guards.js'
import { HostConfigCliError, parseHostConfig } from './host-config.js'
import { KNOWN_HOST_TYPES, type HostConfigInput, type HostType } from '../../hosts/types.js'
import { printSplash } from '../../utils/index.js'
import chalk from 'chalk-template'

export interface ConnectCommandOptions {
  hostType?: string
  hostConfig?: string
  hostConfigFile?: string
  /** `--bind <addr>` */
  bind?: string
  /** `--port <n>` */
  port?: string
  shutdown?: boolean
  /** Project root */
  path: string
}

export async function connectCommand(opts: ConnectCommandOptions): Promise<void> {
  const projectRoot = resolve(opts.path)

  if (opts.shutdown) {
    await runShutdown(projectRoot)
    return
  }

  printSplash()

  const hostType = parseHostType(opts.hostType)
  if (!KNOWN_HOST_TYPES.has(hostType)) {
    console.error(
      chalk`{red Error:} Unknown --host-type '${hostType}' (one of: ssh, ftp, integrated, mcsmanager-login)`,
    )
    process.exit(2)
  }

  const userProvidedHostSettings = !!opts.hostType || !!opts.hostConfig || !!opts.hostConfigFile

  let parsedConfig
  try {
    parsedConfig = await parseHostConfig(opts.hostConfig, opts.hostConfigFile)
  } catch (err) {
    if (err instanceof HostConfigCliError) {
      console.error(chalk`{red Error:} ${err.message}`)
    } else {
      throw err
    }
    process.exit(2)
  }
  for (const w of parsedConfig.warnings) {
    console.error(chalk`{yellow Warning:} ${w}`)
  }
  const config = normalizeConfig(parsedConfig.config, projectRoot)

  const port = opts.port !== undefined ? Number(opts.port) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(chalk`{red Error:} --port must be an integer in [0, 65535]`)
    process.exit(2)
  }

  const handle = await startDaemon({
    hostType,
    config,
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
): HostConfigInput {
  if (raw === undefined || raw === null) {
    return {}
  }
  if (!isObject(raw)) {
    console.error(chalk`{red Error:} --host-config must be a JSON object`)
    process.exit(2)
  }
  const cfg = { ...raw, verbose: true } as HostConfigInput
  if (cfg.projectRoot === undefined) cfg.projectRoot = projectRoot
  return cfg
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