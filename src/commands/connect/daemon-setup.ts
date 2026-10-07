import { join } from 'path'
import { BootstrapError, bootstrapHost } from './bootstrap.js'
import { createDaemonLogger } from './logger.js'
import { Daemon, type DaemonHandle } from './daemon.js'
import { logger, type LoggerSink } from '../../utils/logger.js'
import { loadSandstoneConfig } from '../../utils/sandstoneConfig.js'
import { HostConfigCliError, parseHostConfig } from './host-config.js'
import {
  KNOWN_HOST_TYPES, type HostConfigInput, type HostProvider, type HostType,
} from '../../hosts/types.js'
import chalk from 'chalk-template'

export { createDaemonLogger }

export function prepareConnectSink(
  projectRoot: string,
  options: { headerText?: string, liveCallback?: (sink: LoggerSink) => void } = {},
): LoggerSink {
  const filePath = join(projectRoot, '.sandstone', 'connect.log')
  logger.registerSink('connect', filePath, options.headerText ?? 'Daemon')
  const sink = logger.sinks.connect
  if (options.liveCallback) {
    options.liveCallback(sink)
  }
  return sink
}

export interface StartInProcessDaemonOptions {
  projectRoot: string
  hostType: HostType
  hostConfig: HostConfigInput
  userProvidedHostSettings: boolean
  sink: LoggerSink
  /** Optional. `0` picks a free port. */
  port?: number
  bind?: string
  onHostReady?: (host: HostProvider, spawnedByUs: boolean) => void
}

export async function bootstrapWithShimLogger(opts: {
  projectRoot: string
  hostType: HostType
  hostConfig: HostConfigInput
  userProvidedHostSettings: boolean
  sink: LoggerSink
}): Promise<{ host: HostProvider, spawnedByUs: boolean }> {
  let host: HostProvider
  let spawnedByUs = false
  try {
    const result = await bootstrapHost({
      hostType: opts.hostType,
      config: opts.hostConfig,
      silent: true,
      userProvidedHostSettings: opts.userProvidedHostSettings,
      logger: createDaemonLogger(opts.sink),
    })
    host = result.host
    spawnedByUs = result.spawnedByUs
  } catch (err) {
    const msg = err instanceof BootstrapError
      ? `${err.message} (${err.code})`
      : err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to bootstrap host for in-process daemon: ${msg}`)
  }
  return { host, spawnedByUs }
}

export async function startInProcessDaemon(opts: StartInProcessDaemonOptions): Promise<{
  host: HostProvider,
  handle: DaemonHandle,
  spawnedByUs: boolean,
}> {
  const { host, spawnedByUs } = await bootstrapWithShimLogger(opts)
  if (opts.onHostReady) opts.onHostReady(host, spawnedByUs)
  const handle = await Daemon.connect({
    host,
    projectRoot: opts.projectRoot,
    port: opts.port ?? 0,
    bind: opts.bind,
    logger: createDaemonLogger(opts.sink),
  })
  return { host, handle, spawnedByUs }
}

export const DEFAULT_HOST_TYPE: HostType = 'integrated'

function parseHostType(raw: string | undefined): HostType {
  if (!raw) return DEFAULT_HOST_TYPE
  return raw as HostType
}

export interface ResolveHostAndConfigOptions {
  projectRoot: string
  cliHostType?: string
  cliHostConfig?: string
  cliHostConfigFile?: string
  /** `--port` CLI flag. Validated; `0` means "pick a free port". */
  cliPort?: string
  sink: LoggerSink
  /** Async hook fired after the host type has been determined and
   *  validated, but before any config parsing or setup proceeds. */
  onHostTypeDetermined?: (hostType: HostType) => Promise<void>
}

export interface ResolvedHostAndConfig {
  hostType: HostType
  config: HostConfigInput
  userProvidedHostSettings: boolean
  port: number
}

export async function resolveHostAndConfig(
  opts: ResolveHostAndConfigOptions,
): Promise<ResolvedHostAndConfig> {
  const sandstoneCfg = await loadSandstoneConfig(opts.projectRoot)
  const connectHost = sandstoneCfg?.connect?.host as
    | Record<string, unknown>
    | undefined

  const hostType = parseHostType(opts.cliHostType ?? connectHost?.type as HostType | undefined)
  if (!KNOWN_HOST_TYPES.has(hostType)) {
    opts.sink.logError(chalk`{red Error:} Unknown --host-type '${hostType}' (one of: ssh, ftp, integrated, mcsmanager-login)`)
    process.exit(2)
  }
  if (opts.onHostTypeDetermined) {
    await opts.onHostTypeDetermined(hostType)
  }

  const userProvidedHostSettings = !!opts.cliHostType
    || !!opts.cliHostConfig
    || !!opts.cliHostConfigFile
    || !!connectHost

  let parsed
  try {
    parsed = await parseHostConfig(opts.cliHostConfig, opts.cliHostConfigFile)
    if (Object.keys(parsed.config).length === 0 && connectHost) {
      const { type: _type, ...flat } = connectHost
      parsed = { config: flat as HostConfigInput, warnings: [] }
    }
  } catch (err) {
    if (err instanceof HostConfigCliError) {
      opts.sink.logError(chalk`{red Error:} ${err.message}`)
    } else {
      throw err
    }
    process.exit(2)
  }
  for (const w of parsed.warnings) {
    opts.sink.logWarn(chalk`{yellow Warning:} ${w}`)
  }
  const config = normalizeConfig(parsed.config, opts.projectRoot)

  const port = opts.cliPort !== undefined ? Number(opts.cliPort) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    opts.sink.logError(chalk`{red Error:} --port must be an integer in [0, 65535]`)
    process.exit(2)
  }

  return { hostType, config, userProvidedHostSettings, port }
}

function normalizeConfig(
  raw: HostConfigInput,
  projectRoot: string,
): HostConfigInput {
  if (raw === undefined || raw === null) return {}
  const cfg = { ...raw, verbose: true } as HostConfigInput
  if (cfg.projectRoot === undefined) cfg.projectRoot = projectRoot
  return cfg
}
