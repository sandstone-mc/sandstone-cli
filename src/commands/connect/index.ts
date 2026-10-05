import { resolve } from 'node:path'
import { connect as openClient } from './client.js'
import { startDaemon } from './daemon.js'
import { readEndpoint, pidAlive } from './endpoint-file.js'
import { isObject } from '../../utils/guards.js'
import { HostConfigCliError, parseHostConfig } from './host-config.js'
import { Capability, KNOWN_HOST_TYPES, capabilitiesToRecord, type HostConfigInput, type HostType } from '../../hosts/types.js'
import { printSplash } from '../../utils/index.js'
import { deployDatapack } from '../deploy.js'
import { restartServer, checkRestartCapabilities } from '../restart-server.js'
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
  deploy?: boolean
  restartServer?: boolean
  reload?: boolean
  /** Project root */
  path: string
}

export async function connectCommand(opts: ConnectCommandOptions): Promise<void> {
  const projectRoot = resolve(opts.path)

  if (opts.shutdown) {
    await runShutdown(projectRoot)
    return
  }

  if (opts.reload) {
    await runReloadResources(projectRoot)
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

  if (opts.deploy && hostType === 'integrated') {
    console.error(
      chalk`{red Error:} --deploy is not supported with --host-type integrated. The integrated host exposes build output via symlink; there is nothing to push.`,
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

  if (opts.deploy) {
    if (!handle.host.capabilities.has(Capability.WriteFileStream) || !handle.host.writeFileStream) {
      await handle.shutdown()
      console.error(
        chalk`{red Error:} --deploy needs a host that supports writeFileStream. '${hostType}' does not (capabilities: ${JSON.stringify([...handle.host.capabilities])}).`,
      )
      process.exit(2)
    }

    let deployErr: unknown
    try {
      const client = await openClient({ endpoint: handle.endpoint })
      try {
        const result = await deployDatapack({
          daemon: client,
          projectRoot,
        })
        const uploaded = [result, ...result.dependencies].filter((r) => !r.unchanged)
        const skipped = [result, ...result.dependencies].filter((r) => r.unchanged)
        if (uploaded.length === 0) {
          console.log(
            chalk`{cyan [connect]} nothing to deploy — ${skipped.length} archive(s) already match the server`,
          )
        } else {
          console.log(
            chalk`{cyan [connect]} deployed ${uploaded.length} archive(s):`,
          )
          if (!result.unchanged) {
            console.log(
              chalk`{cyan [connect]}   ${result.archiveName} -> ${result.remotePath} (${result.bytesWritten} bytes)`,
            )
          }
          for (const dep of result.dependencies) {
            if (dep.unchanged) continue
            console.log(
              chalk`{cyan [connect]}   ${dep.name} -> ${dep.remotePath} (${dep.bytesWritten} bytes)`,
            )
          }
          if (skipped.length > 0) {
            console.log(
              chalk`{cyan [connect]}   skipped (unchanged): ${skipped.length} archive(s)`,
            )
          }
        }
        if (result.reloaded) {
          console.log(chalk`{cyan [connect]} reload: ok`)
        } else if (uploaded.length > 0) {
          console.log(chalk`{cyan [connect]} reload: skipped (daemon has no executeRawCommand — run /reload manually)`)
        }
      } finally {
        client.close()
      }
    } catch (err) {
      deployErr = err
    }
    if (deployErr !== undefined) {
      await handle.shutdown()
      const message = deployErr instanceof Error ? deployErr.message : String(deployErr)
      if (message.startsWith('deployed but reload failed')) {
        console.error(
          chalk`{red Error:} ${message}\n\nThe deploy itself succeeded; the server didn't reload. Run \`/reload\` manually.`,
        )
      } else {
        console.error(chalk`{red Error:} deploy failed: ${message}`)
      }
      process.exit(1)
    }
  }

  if (opts.restartServer) {
    const capabilityError = checkRestartCapabilities({
      hostType: handle.host.type,
      capabilities: capabilitiesToRecord(handle.host.capabilities),
    })
    if (capabilityError) {
      await handle.shutdown()
      console.error(chalk`{red Error:} ${capabilityError}`)
      process.exit(2)
    }

    let restartErr: unknown
    try {
      const client = await openClient({ endpoint: handle.endpoint })
      try {
        const result = await restartServer(client, {
          log: (line) => console.log(chalk`{cyan [connect]} ${line}`),
        })
        console.log(
          chalk`{cyan [connect]} server restarted on \`${result.hostType}\` in ${result.elapsedMs}ms`,
        )
      } finally {
        client.close()
      }
    } catch (err) {
      restartErr = err
    }
    if (restartErr !== undefined) {
      await handle.shutdown()
      const message = restartErr instanceof Error ? restartErr.message : String(restartErr)
      console.error(chalk`{red Error:} ${message}`)
      process.exit(1)
    }
  }

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

async function runReloadResources(projectRoot: string): Promise<void> {
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
    console.log(chalk`{cyan [connect]} Connecting to daemon...`)
    const client = await openClient({ endpoint })
    console.log(chalk`{cyan [connect]} Connected! Reloading resources...`)
    try {
      await client.reloadResources()
      client.close()
      console.log(chalk`{cyan [connect]} Reloaded resources on the host!`)
    } catch (err) {
      console.error(chalk`{red Error:} Failed to reload resources: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  } catch (err) {
    console.error(chalk`{red Error:} Failed to reach daemon: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}