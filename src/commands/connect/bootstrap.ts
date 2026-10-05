import { randomBytes } from 'node:crypto'
import path from 'path'
import chalk from 'chalk-template'

import { getAvailableSandstoneVersions } from '../versionDiscovery.js'
import { getProvider } from '../../hosts/registry.js'
import * as fs from '../../utils/fs.js'
import { loadSandstoneConfig } from '../../utils/sandstoneConfig.js'
import { CONSOLE_LOGGER, type DaemonLogger } from './logger.js'
import type { HostConfigInput, HostProvider, HostType } from '../../hosts/types.js'

import '../../hosts/index.js'
import { loadActiveConfigFromDisk } from './active-config.js';

export interface BootstrapOptions {
  hostType: HostType
  config: HostConfigInput
  /** When true, the caller passed explicit `--host-type` / `--host-config`
   *  flags. Suppresses the bootstrap auto-config lookup. */
  userProvidedHostSettings?: boolean
  silent?: boolean
  logger?: DaemonLogger
}

export interface BootstrapResult {
  host: HostProvider
  config: HostConfigInput
  spawnedByUs: boolean
}

export class BootstrapError extends Error {
  constructor(message: string, public readonly code: 'no-factory' | 'host-failed' | 'start-failed') {
    super(message)
    this.name = 'BootstrapError'
  }
}

/**
 * Resolve default config + instantiate + connect + start + wrap.
 */
export async function bootstrapHost(opts: BootstrapOptions): Promise<BootstrapResult> {
  const hostType = opts.hostType
  const logger = opts.logger ?? CONSOLE_LOGGER
  let config = await resolveDefaults(hostType, opts.config, opts.silent ?? false, logger)

  const autocfg = await loadSandstoneConfig(process.cwd())
  const activeSaveConfig = await loadActiveConfigFromDisk(process.cwd())
  if (autocfg) {
    if (!('sandstoneConfig' in config)) {
      config = {
        ...config,
        sandstoneConfig: autocfg,
        ...(activeSaveConfig?.saveConfig === undefined ? {} : { saveConfig: activeSaveConfig.saveConfig })
      }
    }
  }

  const factory = getProvider(hostType)
  if (!factory) {
    throw new BootstrapError(`Unknown host type: ${hostType}`, 'no-factory')
  }
  let host: HostProvider
  try {
    host = factory.create(config, logger)
  } catch (e) {
    throw new BootstrapError(
      `Failed to construct host '${hostType}': ${e instanceof Error ? e.message : String(e)}`,
      'host-failed',
    )
  }

  const hasStartServer = host.capabilities.has('startServer')

  try {
    await host.connect()
  } catch (e) {
    throw new BootstrapError(
      `Failed to connect host '${hostType}': ${e instanceof Error ? e.message : String(e)}`,
      'host-failed',
    )
  }

  const started: HostType[] = []
  let spawnedByUs = false
  if (hasStartServer && host.startServer) {
    try {
      await host.startServer()
      started.push(hostType)
      const maybeIntegrated = host as { weStartedThisCall?: () => boolean }
      if (maybeIntegrated.weStartedThisCall?.()) {
        spawnedByUs = true
      }
    } catch (e) {
      throw new BootstrapError(
        `Failed to start server on '${hostType}': ${e instanceof Error ? e.message : String(e)}`,
        'start-failed',
      )
    }
  }

  return { host, config, spawnedByUs }
}

async function resolveDefaults(
  hostType: HostType,
  input: Partial<HostConfigInput>,
  silent: boolean,
  logger: DaemonLogger,
): Promise<Partial<HostConfigInput>> {
  let out: Partial<HostConfigInput> = JSON.parse(JSON.stringify(input))
  const log = silent ? () => {} : logger.info.bind(logger)

  if (hostType === 'integrated') {
    const integratedCfg = { ...(out as Record<string, unknown>) }
    if (typeof integratedCfg.sandstoneVersion !== 'string') {
      try {
        const pkg = await fs.readJSON<{ version?: string }>(
          path.join(process.cwd(), 'node_modules', 'sandstone', 'package.json'),
        )
        if (pkg.version) {
          integratedCfg.sandstoneVersion = pkg.version
          log(chalk`{cyan [bootstrap]} using mc version for sandstone version ${pkg.version}`)
        }
      } catch {
        try {
          const versions = await getAvailableSandstoneVersions()
          const top = versions[0]
          if (top) {
            const tag = `${top.major}.${top.minor}.0`
            integratedCfg.sandstoneVersion = tag
            log(chalk`{cyan [bootstrap]} using mc version for sandstone version ${tag}`)
          }
        } catch (err) {
          logger.error(
            `[bootstrap] could not fetch latest sandstone version: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }

    const existing = (integratedCfg.rcon as Record<string, unknown> | undefined) ?? {}
    let resolvedPort = existing.port as number | undefined
    if (!resolvedPort || (resolvedPort as number) <= 0) {
      resolvedPort = await findOpenPort()
      log(chalk`{cyan [bootstrap]} rcon port not set -- picked ${resolvedPort}`)
    }
    let resolvedPassword = existing.password as string | undefined
    if (!resolvedPassword) {
      resolvedPassword = randomBytes(16).toString('hex')
      log(chalk`{cyan [bootstrap]} rcon password not set -- generated random`)
    }
    integratedCfg.rcon = {
      ...existing,
      enabled: existing.enabled ?? true,
      port: resolvedPort,
      password: resolvedPassword,
    }
    out = integratedCfg as HostConfigInput
  }

  return out
}

async function findOpenPort(): Promise<number> {
  const tryBind = (port: number): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const server = Bun.serve({
        port,
        fetch: () => new Response(),
      })
      const bound = server.port ?? port
      server.stop().then(
        () => resolve(bound),
        (err) => reject(err),
      )
    })
  for (let port = 25575; port < 65535; port++) {
    try {
      return await tryBind(port)
    } catch {
      // in use, try next
    }
  }
  throw new Error('No open port found in 25575-65534')
}
