import * as path from 'path'
import AdmZip from 'adm-zip'
import { Client } from '../connect/client.js'
import { Daemon } from '../connect/daemon.js'
import { NULL_LOGGER } from '../connect/logger.js'
import { readEndpoint, pidAlive } from '../connect/endpoint-file.js'
import {
  bootstrapWithShimLogger,
  prepareConnectSink,
  resolveHostAndConfig,
} from '../connect/daemon-setup.js'
import { parseBenchConfig, readBenchConfigFile } from './config.js'
import { buildBenchPack, buildBenchPackDisableFiles, BENCH_PACK_DIR } from './datapack.js'
import { averageRuns, mean } from './average.js'
import { emitStatus } from './events.js'
import { benchResultToJson } from './format.js'
import { measureTargets, parseProfileDump } from './profile.js'
import { Capability } from '../../hosts/types.js'
import * as fs from '../../utils/fs.js'
import type { BenchEventSink, BenchResult, BenchRun } from './types.js'
import { BenchConfigError } from './types.js'

export interface BenchCommandOptions {
  /** Path of the Sandstone project. */
  path: string
  /** Path to the JSON config file, relative to the project. */
  config: string
  hostType?: string
  hostConfig?: string
  hostConfigFile?: string
  json?: boolean
  /** Overrides the config file's `iterationsPerTick`. */
  iterations?: string
  /** Seconds to wait after the setup function before the measured window. */
  settle?: string
  /** How many profiling runs to average over. */
  runs?: string
}

/**
 * How long to let the server settle after the setup function, before the
 * measured window starts.
 */
const DEFAULT_SETTLE_SECONDS = 10

const REPORT_FILENAME = 'bench-result.json'

const MAX_RUNS = 50

const PROFILE_TIMEOUT_MS = 90_000

const ARCHIVE_RETRY_MS = 10_000

const RELOAD_TIMEOUT_MS = 120_000

const ARCHIVE_PATTERN = /Compressed to (debug\/profiling\/[^\s]+\.zip)/

const PROFILING_ENTRY = 'server/profiling.txt'

interface BenchSurface {
  executeRawCommand(command: string): Promise<string | undefined>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: string): Promise<void>
  deleteEntry?(path: string): Promise<void>
  attachLog(regex: string): Promise<{
    onLines(fn: (lines: { line: string }[]) => void): void
    unattach(): Promise<void>
  }>
  reloadResources(): Promise<void>
  close(): Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, ms)
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

function clientSurface(client: Client): BenchSurface {
  const surface: BenchSurface = {
    async executeRawCommand(command) {
      const result = await client.executeRawCommand({ command })
      return result.output
    },
    async readFile(filePath) {
      return Buffer.from(await client.readFile({ path: filePath }))
    },
    async writeFile(filePath, data) {
      await client.writeFile({ path: filePath, data })
    },
    attachLog(regex) {
      return client.attachLog({ regex })
    },
    reloadResources() {
      return client.reloadResources()
    },
    async close() {
      client.close()
    },
  }

  if (client.welcome.capabilities.deleteEntry) {
    surface.deleteEntry = async (filePath) => {
      await client.deleteEntry({ path: filePath })
    }
  }

  return surface
}

function daemonSurface(daemon: Daemon): BenchSurface {
  const surface: BenchSurface = {
    async executeRawCommand(command) {
      const result = await daemon.executeRawCommand({ command })
      return result.output
    },
    async readFile(filePath) {
      const data = await daemon.readFile(filePath)
      if (typeof data === 'string') return Buffer.from(data)
      return Buffer.from(data)
    },
    async writeFile(filePath, data) {
      await daemon.writeFile(filePath, data)
    },
    attachLog(regex) {
      return daemon.attachLog({ regex })
    },
    reloadResources() {
      return daemon.reloadResources()
    },
    async close() {},
  }

  if (daemon.host.capabilities.has(Capability.DeleteEntry)) {
    surface.deleteEntry = async (filePath) => {
      await daemon.deleteEntry({ path: filePath })
    }
  }

  return surface
}

async function openSurface(
  opts: BenchCommandOptions,
  projectRoot: string,
  onEvent: BenchEventSink,
): Promise<BenchSurface> {
  const endpoint = await readEndpoint(projectRoot)
  const daemonAlive = !!(endpoint && (await pidAlive(endpoint.pid)))

  if (daemonAlive && endpoint) {
    emitStatus(`Using the running sand connect daemon at ${endpoint.url}`, onEvent, 'daemon_connected')
    const client = await Client.open({ endpoint, logger: NULL_LOGGER })
    const caps = client.welcome.capabilities
    const missing = (['executeRawCommand', 'readFile', 'writeFile', 'attachLog'] as const)
      .filter((cap) => !caps[cap])
    if (missing.length > 0) {
      client.close()
      throw new Error(`The host does not support: ${missing.join(', ')}.`)
    }
    return clientSurface(client)
  }

  const sink = prepareConnectSink(projectRoot, { headerText: 'Bench', liveCallback: () => {} })
  const resolved = await resolveHostAndConfig({
    projectRoot,
    cliHostType: opts.hostType,
    cliHostConfig: opts.hostConfig,
    cliHostConfigFile: opts.hostConfigFile,
    sink,
  })

  emitStatus(`Bootstrapping the ${resolved.hostType} host...`, onEvent, 'host_bootstrapping')
  const { host } = await bootstrapWithShimLogger({
    projectRoot,
    hostType: resolved.hostType,
    hostConfig: resolved.config,
    userProvidedHostSettings: resolved.userProvidedHostSettings,
    sink,
  })

  const daemon = Daemon.forDirect(host)
  const missing = (['executeRawCommand', 'readFile', 'writeFile', 'attachLog'] as const)
    .filter((cap) => !host.capabilities.has(cap))
  if (missing.length > 0) {
    await host.disconnect().catch(() => {})
    throw new Error(`The host does not support: ${missing.join(', ')}.`)
  }

  return daemonSurface(daemon)
}

async function captureProfileArchive(surface: BenchSurface): Promise<string> {
  const subscription = await surface.attachLog(ARCHIVE_PATTERN.source)

  const announced = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `The server did not report a profiling archive within ${PROFILE_TIMEOUT_MS / 1000}s. `
        + 'Is the server running, and does the account have permission to run `perf`?',
      ))
    }, PROFILE_TIMEOUT_MS)
    timer.unref?.()

    subscription.onLines((lines) => {
      for (const entry of lines) {
        const match = ARCHIVE_PATTERN.exec(entry.line)
        if (!match) continue
        clearTimeout(timer)
        resolve(match[1]!)
        return
      }
    })
  })

  announced.catch(() => {})

  try {
    const output = await surface.executeRawCommand('perf start')
    if (output && /already started/i.test(output)) {
      throw new Error(
        'A profiling run is already in progress on the server. Run `perf stop` on it before benchmarking.',
      )
    }
    return await announced
  } finally {
    await subscription.unattach().catch(() => {})
  }
}

async function readArchive(surface: BenchSurface, archivePath: string): Promise<Buffer> {
  const deadline = Date.now() + ARCHIVE_RETRY_MS
  let lastError: unknown

  for (;;) {
    try {
      return await surface.readFile(archivePath)
    } catch (err) {
      lastError = err
      if (Date.now() >= deadline) break
      await sleep(250)
    }
  }

  throw new Error(
    `Could not read the profiling archive at ${archivePath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

function extractProfilingText(archive: Buffer): string {
  const zip = new AdmZip(archive)
  const entry = zip.getEntry(PROFILING_ENTRY)
  if (!entry) {
    const names = zip.getEntries().map((e) => e.entryName)
    throw new Error(
      `The profiling archive has no "${PROFILING_ENTRY}" entry. It contains: ${names.join(', ')}`,
    )
  }
  return entry.getData().toString('utf8')
}

function parseSettleSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SETTLE_SECONDS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new BenchConfigError(`--settle must be a number of seconds (got "${raw}").`)
  }
  return value
}

function parseRuns(raw: string | undefined): number {
  if (raw === undefined) return 1
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new BenchConfigError(`--runs must be a positive integer (got "${raw}").`)
  }
  if (value > MAX_RUNS) {
    throw new BenchConfigError(`--runs is capped at ${MAX_RUNS} (got ${value}).`)
  }
  return value
}

async function runHelperFunction(surface: BenchSurface, functionId: string, role: string): Promise<void> {
  const output = await surface.executeRawCommand(`function ${functionId}`)
  if (!output || !/running function/i.test(output)) {
    const detail = output?.trim()
    throw new Error(
      `The ${role} function "${functionId}" could not be run on the server.`
      + (detail ? ` The server said: ${detail}` : ''),
    )
  }
}

async function writeBenchReport(projectRoot: string, result: BenchResult): Promise<string> {
  const dir = path.join(projectRoot, '.sandstone')
  const file = path.join(dir, REPORT_FILENAME)
  await fs.ensureDir(dir)
  await fs.writeText(file, `${JSON.stringify(benchResultToJson(result), null, 2)}\n`)
  return file
}

export async function runBench(
  opts: BenchCommandOptions,
  onEvent: BenchEventSink = () => {},
): Promise<BenchResult> {
  const projectRoot = path.resolve(opts.path)
  const configPath = path.resolve(projectRoot, opts.config)

  const raw = await readBenchConfigFile(configPath)
  const iterationOverride = opts.iterations === undefined ? undefined : Number(opts.iterations)
  const plan = parseBenchConfig(raw, iterationOverride)

  const settleSeconds = parseSettleSeconds(opts.settle)
  const runCount = parseRuns(opts.runs)

  emitStatus(`Reading ${path.relative(projectRoot, configPath) || configPath}`, onEvent, 'config')

  const surface = await openSurface(opts, projectRoot, onEvent)
  let profilingStarted = false

  try {
    for (const file of buildBenchPack(plan.targets)) {
      await surface.writeFile(file.path, file.content)
    }
    emitStatus(`Deployed the benchmark harness to ${BENCH_PACK_DIR}`, onEvent, 'harness_deployed')

    emitStatus('Reloading server resources...', onEvent, 'reloading')
    await withTimeout(
      surface.reloadResources(),
      RELOAD_TIMEOUT_MS,
      `The server did not finish reloading within ${RELOAD_TIMEOUT_MS / 1000}s.`,
    )

    const runs: BenchRun[] = []

    // The setup runs once for the whole batch, and so does the cleanup.
    // The functions under test simply keep running across the runs, so
    // whatever they accumulate carries over from one profile to the next.
    if (plan.setup) {
      emitStatus(`Running the setup function ${plan.setup}`, onEvent, 'setup')
      await runHelperFunction(surface, plan.setup, 'setup')
    }

    // Let the server settle: the setup's effects (forceloads, entity
    // removals) finish applying, and the functions get compiled.
    if (settleSeconds > 0) {
      emitStatus(`Settling for ${settleSeconds}s...`, onEvent, 'settling')
    }
    await sleep(settleSeconds * 1000)

    for (let index = 0; index < runCount; index++) {
      const run = index + 1
      emitStatus(`Profiling run ${run}/${runCount}...`, onEvent, 'profiling', { run, runs: runCount })

      const archivePath = await captureProfileArchive(surface)
      profilingStarted = true

      const archive = await readArchive(surface, archivePath)
      const dump = parseProfileDump(extractProfilingText(archive))
      const measurements = measureTargets(dump, plan.targets)

      emitStatus(
        `Run ${run}/${runCount} finished — ${dump.tickSpan} ticks over ${(dump.timeSpanMs / 1000).toFixed(2)}s`
        + measurements.map((measurement) => ` · ${measurement.label.toUpperCase()} ${measurement.msPerTick.toFixed(3)} ms/tick`).join(''),
        onEvent,
        'profiled',
        { run, runs: runCount },
      )

      runs.push({
        index,
        timeSpanMs: dump.timeSpanMs,
        tickSpan: dump.tickSpan,
        profilePath: archivePath,
        targets: measurements,
      })
    }

    const targets = averageRuns(runs)
    if (runCount > 1) {
      emitStatus(`Averaging ${runCount} runs`, onEvent, 'averaging')
    }

    const result: BenchResult = {
      timeSpanMs: mean(runs.map((run) => run.timeSpanMs)),
      tickSpan: mean(runs.map((run) => run.tickSpan)),
      runCount: runs.length,
      profilePaths: runs.map((run) => run.profilePath),
      targets,
      runs,
      reportPath: path.join('.sandstone', REPORT_FILENAME),
    }

    // Always keep a copy of the numbers, whatever the output mode.
    await writeBenchReport(projectRoot, result)
    emitStatus(`Report written to ${result.reportPath}`, onEvent, 'report_written')

    return result
  } finally {
    if (profilingStarted) {
      await surface.executeRawCommand('perf stop').catch(() => {})
    }
    if (plan.cleanup) {
      emitStatus(`Running the cleanup function ${plan.cleanup}`, onEvent, 'cleanup')
      await runHelperFunction(surface, plan.cleanup, 'cleanup').catch(() => {})
    }
    // Remove the temporary datapack. Hosts that can delete files get it
    // deleted outright; the rest fall back to disabling it, which leaves the
    // files behind but stops them from running.
    if (surface.deleteEntry) {
      await surface.deleteEntry(BENCH_PACK_DIR).catch(() => {})
    } else {
      for (const file of buildBenchPackDisableFiles(plan.targets)) {
        await surface.writeFile(file.path, file.content).catch(() => {})
      }
    }
    // Either way the server has to be told to drop what it loaded — a pack
    // deleted from disk stays live until the next reload.
    await surface.reloadResources().catch(() => {})
    await surface.close()
  }
}
