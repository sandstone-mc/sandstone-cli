import * as path from 'path'
import chalk from 'chalk-template'
import { emitError, emitStatus } from './events.js'
import { runSession, type TestSession } from './session.js'
import type {
  TestEventSink,
  TestsManifest,
} from './types.js'
import type { HostProvider, HostType, LogSubscription } from '../../hosts/types.js'
import { DEFAULT_HOST_TYPE } from '../connect/index.js'
import { BootstrapError, bootstrapHost } from '../connect/bootstrap.js'
import { Client as DaemonClient } from '../connect/client.js'
import { Daemon } from '../connect/daemon.js'
import { readEndpoint, pidAlive } from '../connect/endpoint-file.js'
import { parseHostConfig } from '../connect/host-config.js'
import type { ExecuteRawCommandResult } from '../connect/rpc.js'
import { KNOWN_HOST_TYPES } from '../../hosts/types.js'
import { createDaemonLogger } from '../connect/logger.js'
import { logger } from '../../utils/logger.js'

type TestSurface = DaemonClient | Daemon

const TEST_COMMAND = 'test run *:*'

export async function runTests(
  opts: import('./types.js').TestCommandOptions,
  signal?: AbortSignal,
  onEvent?: TestEventSink,
  existingSurface?: TestSurface,
): Promise<number> {
  const projectRoot = path.resolve(opts.path)
  const sink: TestEventSink = onEvent ?? ((e) => console.log(JSON.stringify(e)))

  let manifest: TestsManifest | null = null
  try {
    manifest = JSON.parse(await Bun.file(path.resolve(projectRoot, '.sandstone', 'tests.json')).text()) as TestsManifest
  } catch {}
  if (!manifest) {
    emitError(
      'Test manifest not found. Run `sand build --test` to generate tests, then retry.',
      sink,
    )
    return 2
  }

  if (existingSurface) {
    emitStatus(chalk`Using watcher-owned \`sand connect\` surface`, sink, 'daemon_connected', { url: '' })
    return runDaemon(undefined, manifest, sink, projectRoot, signal, existingSurface)
  }

  const endpoint = await readEndpoint(projectRoot)
  const daemonAlive = !!(endpoint && (await pidAlive(endpoint.pid)))
  if (daemonAlive && endpoint) {
    emitStatus(
      chalk`Using existing \`sand connect\` daemon at {cyan ${endpoint.url}}`,
      sink,
      'daemon_connected',
      { url: endpoint.url },
    )
  } else {
    emitStatus(
      chalk`Bootstrapping {bold ${opts.hostType ?? DEFAULT_HOST_TYPE}} host...`,
      sink,
      'host_bootstrapping',
      { host_type: opts.hostType ?? DEFAULT_HOST_TYPE },
    )
  }

  let hostType: HostType | undefined
  if (opts.hostType) {
    if (opts.hostType.includes(',')) {
      emitError(
        `Only one --host-type is supported, got '${opts.hostType}'. Composite daemons were removed.`,
        sink,
      )
      return 2
    }
    hostType = opts.hostType as HostType
  }
  const userProvidedHostSettings = !!opts.hostType || !!opts.hostConfig || !!opts.hostConfigFile
  if (!daemonAlive) {
    if (!hostType) hostType = DEFAULT_HOST_TYPE
    if (!KNOWN_HOST_TYPES.has(hostType as HostType)) {
      emitError(`Unknown --host-type '${hostType}'`, sink)
      return 2
    }
    if (opts.hostConfig && opts.hostConfigFile) {
      emitError('Pass either --host-config or --host-config-file, not both', sink)
      return 2
    }
    if (!opts.hostConfig && !opts.hostConfigFile) {
      opts.hostConfig = JSON.stringify({})
    }
  }
  const resolvedHostType: HostType = hostType ?? DEFAULT_HOST_TYPE

  if (daemonAlive && endpoint) {
    return runDaemon(endpoint, manifest, sink, projectRoot, signal)
  }

  return runDirect(projectRoot, resolvedHostType, opts, userProvidedHostSettings, manifest, sink, signal)
}

async function runDaemon(
  endpoint: NonNullable<Awaited<ReturnType<typeof readEndpoint>>> | undefined,
  manifest: TestsManifest,
  onEvent: TestEventSink,
  projectRoot: string,
  signal?: AbortSignal,
  existingSurface?: TestSurface,
): Promise<number> {
  const ownsClient = !existingSurface
  const client: TestSurface = existingSurface ?? (await DaemonClient.open({ endpoint: endpoint!, logger: createDaemonLogger(logger.sinks.test) }))
  const caps = client instanceof Daemon ? client.host.capabilities : new Set(Object.entries(client.welcome.capabilities).filter(([, v]) => v).map(([k]) => k))
  const hostType = (client instanceof Daemon ? client.host.type : client.welcome.hostType) as HostType
  if (!caps.has('executeRawCommand')) {
    emitError('Host does not support executeRawCommand', onEvent)
    if (ownsClient) client.close()
    process.exit(2)
  }
  if (!caps.has('attachLog')) {
    emitError('Host does not support attachLog', onEvent)
    if (ownsClient) client.close()
    process.exit(2)
  }

  return runSession(
    {
      attachLog: async (handler) => client.attachLog().then((sub) => {
        sub.onLines((lines) => handler(lines))
        return sub
      }),
      executeRawCommand: () => client.executeRawCommand({ command: TEST_COMMAND }),
      cleanup: () => {
        if (ownsClient) client.close()
        return Promise.resolve()
      },
    },
    manifest,
    onEvent,
    hostType,
    projectRoot,
    signal,
  )
}

async function runDirect(
  projectRoot: string,
  resolvedHostType: HostType,
  opts: import('./types.js').TestCommandOptions,
  userProvidedHostSettings: boolean,
  manifest: TestsManifest,
  onEvent: TestEventSink,
  signal?: AbortSignal,
): Promise<number> {
  const parsedConfig = await parseHostConfig(opts.hostConfig, opts.hostConfigFile)
  const hostConfig = parsedConfig.config
  if (hostConfig.projectRoot === undefined) hostConfig.projectRoot = projectRoot

  let host: HostProvider
  let weStarted = false
  try {
    const result = await bootstrapHost({
      hostType: resolvedHostType,
      config: hostConfig,
      silent: true,
      userProvidedHostSettings,
    })
    host = result.host
    weStarted = result.spawnedByUs
  } catch (err) {
    const msg =
      err instanceof BootstrapError
        ? `${err.message} (${err.code})`
        : err instanceof Error
          ? err.message
          : String(err)
    emitError(msg, onEvent)
    process.exit(2)
  }

  if (!host.capabilities.has('executeRawCommand')) {
    emitError(`Host '${resolvedHostType}' does not support executeRawCommand`, onEvent)
    await safeDisconnect(host)
    process.exit(2)
  }
  if (!host.capabilities.has('attachLog') || !host.attachLog) {
    emitError(`Host '${resolvedHostType}' does not support attachLog`, onEvent)
    await safeDisconnect(host)
    process.exit(2)
  }

  return runSession(
    {
      attachLog: (handler) => host.attachLog!(handler),
      executeRawCommand: () => host.executeRawCommand!(TEST_COMMAND),
      cleanup: async () => {
        if (weStarted && host.type === 'integrated' && host.stopServer && host.capabilities.has('stopServer')) {
          emitStatus('Stopping server...', onEvent, 'server_stopping')
          await host.stopServer().catch(() => {})
        }
        await safeDisconnect(host)
      },
    },
    manifest,
    onEvent,
    host.type,
    projectRoot,
    signal,
  )
}

async function safeDisconnect(host: HostProvider): Promise<void> {
  try {
    await host.disconnect()
  } catch {}
}

export type { TestSession, LogSubscription, ExecuteRawCommandResult }