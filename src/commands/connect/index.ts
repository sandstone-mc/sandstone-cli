import { resolve } from 'node:path'
import { Client } from './client.js'
import { prepareConnectSink, resolveHostAndConfig, startInProcessDaemon } from './daemon-setup.js'
import { readEndpoint, pidAlive } from './endpoint-file.js'
import { isObject } from '../../utils/guards.js'
import { loadSandstoneConfig } from '../../utils/sandstoneConfig.js'
import { Capability, capabilitiesToRecord, type HostConfigInput, type HostType } from '../../hosts/types.js'
import type { LoggerSink } from '../../utils/logger.js'
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

  const connectSink = prepareConnectSink(projectRoot, {
    liveCallback: (sink) => {
      sink.setLiveCallback((level, args) => {
        const text = args.map((a) =>
          typeof a === 'string' ? a
          : Array.isArray(a) ? a.join('')
          : String(a)
        ).join(' ')
        if (level === 'ERROR' || level === 'WARN') process.stderr.write(`${text}\n`)
        else process.stdout.write(`${text}\n`)
      })
    },
  })
  const logInfo = connectSink.logInfo
  const logError = connectSink.logError

  if (opts.shutdown) {
    await runShutdown(projectRoot, connectSink)
    return
  }

  if (opts.reload) {
    await runReloadResources(projectRoot, connectSink)
    return
  }

  printSplash()

  const resolved = await resolveHostAndConfig({
    projectRoot,
    cliHostType: opts.hostType,
    cliHostConfig: opts.hostConfig,
    cliHostConfigFile: opts.hostConfigFile,
    cliPort: opts.port,
    sink: connectSink,
  })

  if (opts.deploy && resolved.hostType === 'integrated') {
    logError(chalk`{red Error:} --deploy is not supported with --host-type integrated. The integrated host exposes build output via symlink; there is nothing to push.`)
    process.exit(2)
  }

  const { handle } = await startInProcessDaemon({
    projectRoot,
    hostType: resolved.hostType,
    hostConfig: resolved.config,
    userProvidedHostSettings: resolved.userProvidedHostSettings,
    bind: opts.bind,
    port: resolved.port,
    sink: connectSink,
  })

  if (opts.deploy) {
    if (!handle.daemon.host.capabilities.has(Capability.WriteFileStream) || !handle.daemon.host.writeFileStream) {
      await handle.shutdown()
      logError(
        chalk`{red Error:} --deploy needs a host that supports writeFileStream. '${resolved.hostType}' does not (capabilities: ${JSON.stringify([...handle.daemon.host.capabilities])}).`,
      )
      process.exit(2)
    }

    let deployErr: unknown
    try {
      const client = await Client.open({ endpoint: handle.endpoint })
      try {
        const result = await deployDatapack({
          daemon: client,
          projectRoot,
        })
        const uploaded = [result, ...result.dependencies].filter((r) => !r.unchanged)
        const skipped = [result, ...result.dependencies].filter((r) => r.unchanged)
        if (uploaded.length === 0) {
          logInfo(chalk`{cyan [connect]} nothing to deploy — ${skipped.length} archive(s) already match the server`)
        } else {
          logInfo(chalk`{cyan [connect]} deployed ${uploaded.length} archive(s):`)
          if (!result.unchanged) {
            logInfo(chalk`{cyan [connect]}   ${result.archiveName} -> ${result.remotePath} (${result.bytesWritten} bytes)`)
          }
          for (const dep of result.dependencies) {
            if (dep.unchanged) continue
            logInfo(chalk`{cyan [connect]}   ${dep.name} -> ${result.remotePath} (${dep.bytesWritten} bytes)`)
          }
          if (skipped.length > 0) {
            logInfo(chalk`{cyan [connect]}   skipped (unchanged): ${skipped.length} archive(s)`)
          }
        }
        if (result.reloaded) {
          logInfo(chalk`{cyan [connect]} reload: ok`)
        } else if (uploaded.length > 0) {
          logInfo(chalk`{cyan [connect]} reload: skipped (daemon has no executeRawCommand — run /reload manually)`)
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
        logError(
          chalk`{red Error:} ${message}\n\nThe deploy itself succeeded; the server didn't reload. Run \`/reload\` manually.`,
        )
      } else {
        logError(chalk`{red Error:} deploy failed: ${message}`)
      }
      process.exit(1)
    }
  }

  if (opts.restartServer) {
    const capabilityError = checkRestartCapabilities({
      hostType: handle.daemon.host.type,
      capabilities: capabilitiesToRecord(handle.daemon.host.capabilities),
    })
    if (capabilityError) {
      await handle.shutdown()
      logError(chalk`{red Error:} ${capabilityError}`)
      process.exit(2)
    }

    let restartErr: unknown
    try {
      const client = await Client.open({ endpoint: handle.endpoint })
      try {
        const result = await restartServer(client, {
          log: (line) => logInfo(chalk`{cyan [connect]} ${line}`),
        })
        logInfo(chalk`{cyan [connect]} server restarted on \`${result.hostType}\` in ${result.elapsedMs}ms`)
      } finally {
        client.close()
      }
    } catch (err) {
      restartErr = err
    }
    if (restartErr !== undefined) {
      await handle.shutdown()
      const message = restartErr instanceof Error ? restartErr.message : String(restartErr)
      logError(chalk`{red Error:} ${message}`)
      process.exit(1)
    }
  }
  await handle.done
  process.exit(0)
}

export const DEFAULT_HOST_TYPE: HostType = 'integrated'
async function runShutdown(projectRoot: string, sink: LoggerSink): Promise<void> {
  const endpoint = await readEndpoint(projectRoot)
  if (!endpoint) {
    sink.logError(chalk`{red Error:} No endpoint file at ${projectRoot}/.sandstone/connect.url — no daemon to shut down`)
    process.exit(1)
  }
  if (!(await pidAlive(endpoint.pid))) {
    sink.logError(chalk`{red Error:} Endpoint file references pid ${endpoint.pid} which is not alive`)
    process.exit(1)
  }
  try {
    const client = await Client.open({ endpoint })
    await client.shutdown()
    client.close()
    sink.logInfo(chalk`{cyan [connect]} shutdown sent to daemon (pid ${endpoint.pid})`)
  } catch (err) {
    sink.logError(chalk`{red Error:} Failed to reach daemon: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

async function runReloadResources(projectRoot: string, sink: LoggerSink): Promise<void> {
  const endpoint = await readEndpoint(projectRoot)
  if (!endpoint) {
    sink.logError(chalk`{red Error:} No endpoint file at ${projectRoot}/.sandstone/connect.url — no daemon to shut down`)
    process.exit(1)
  }
  if (!(await pidAlive(endpoint.pid))) {
    sink.logError(chalk`{red Error:} Endpoint file references pid ${endpoint.pid} which is not alive`)
    process.exit(1)
  }
  try {
    sink.logInfo(chalk`{cyan [connect]} Connecting to daemon...`)
    const client = await Client.open({ endpoint })
    sink.logInfo(chalk`{cyan [connect]} Connected! Reloading resources...`)
    try {
      await client.reloadResources()
      client.close()
      sink.logInfo(chalk`{cyan [connect]} Reloaded resources on the host!`)
    } catch (err) {
      sink.logError(chalk`{red Error:} Failed to reload resources: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  } catch (err) {
    sink.logError(chalk`{red Error:} Failed to reach daemon: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
