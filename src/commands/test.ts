/**
 * `sand test` — run GameTests on the configured server and parse failures
 * from the server log.
 *
 * Behavior:
 *  - Connects through the same machinery as `sand run`: prefers a live
 *    `sand connect` daemon (WS), falls back to direct-mode host bootstrap.
 *  - Sends exactly one console command: `test run *:*`.
 *  - **Before** sending the command, attaches to the server log so every
 *    line the server emits is captured. While lines stream in, toggles a
 *    `collecting` flag on each occurrence of `Running test environment …`
 *    (enter) and `Game Test complete!` (exit). Between those two markers
 *    the tool runs every line through `parseFailureLog` (exported from
 *    `sandstone/test`) and accumulates the parsed failures.
 *  - Loads `<project>/.sandstone/tests.json` to learn each registered
 *    test's description + optional flag. Renders one line per test
 *    using parsed failure data (or absence of it) so passing tests are
 *    visible too.
 *
 * Exit codes:
 *  - 0 — no required failures (either no failures at all, or only
 *    optional ones).
 *  - 1 — at least one required failure, or the run did not see a
 *    closing `Game Test complete!`.
 *  - 2 — argument / connection error (mirrors `sand run`).
 */

import path, { join, resolve } from 'path'
import { connect as openClient } from './connect/client.js'
import { pidAlive, readEndpoint } from './connect/endpoint-file.js'
import { BootstrapError, bootstrapHost } from './connect/bootstrap.js'
import { KNOWN_HOST_TYPES } from '../hosts/types.js'
import type { HostProvider, HostType, LogChunkHandler, LogSubscription } from '../hosts/types.js'
import { DEFAULT_HOST_TYPE } from './connect/index.js'
import { parseHostConfig } from './connect/host-config.js'
import { parseFailureLog, type ParsedFailureLog } from 'sandstone/test'
import { stripMinecraftPrefix } from './run.js'
import { printSplash } from '../utils/index.js'
import chalk from 'chalk-template'

export interface TestCommandOptions {
  hostType?: string
  hostConfig?: string
  hostConfigFile?: string
  /** `--path <path>` (project root). */
  path: string
}

const TRIGGER_PREFIX = 'Running test environment'
const COMPLETE_PREFIX = 'Game Test complete!'
const TEST_COMMAND = 'test run *:*'

interface TestEntry {
  name: string
  description?: string
  optional?: boolean
  /** Source file where `Test.create(...)` was invoked. Lets `sand test`
   * report an accurate "Ran M tests across N files" count without
   * inferring files from the `throwables` record (which only contains
   * fallable tests). */
  sourceFile?: string
}

interface ThrowableEntry {
  trace?: { file?: string; line?: number; column?: number; name?: string }
  command?: string
  line?: number
}

interface TestsManifest {
  tests: TestEntry[]
  /** Keyed by `${namespace}:${name}@${command}:${sourceLine}` as
   *  emitted by the build step's `throwableStack`. Lets us link a
   *  runtime failure to the user source line that produced it. */
  throwables: Record<string, ThrowableEntry>
}

async function loadTestsManifest(projectRoot: string): Promise<TestsManifest | null> {
  const path = resolve(projectRoot, '.sandstone', 'tests.json')
  let text: string
  try {
    text = await Bun.file(path).text()
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as { tests?: unknown; throwables?: unknown }
    const raw = Array.isArray(parsed.tests) ? parsed.tests : []
    const entries: TestEntry[] = []
    for (const item of raw) {
      if (typeof item === 'string') {
        entries.push({ name: item })
      } else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
        const e = item as { name: string; description?: unknown; optional?: unknown }
        entries.push({
          name: e.name,
          description: typeof e.description === 'string' ? e.description : undefined,
          optional: typeof e.optional === 'boolean' ? e.optional : undefined,
        })
      }
    }
    const throwables: Record<string, ThrowableEntry> =
      parsed.throwables && typeof parsed.throwables === 'object'
        ? (parsed.throwables as Record<string, ThrowableEntry>)
        : {}
    return { tests: entries, throwables }
  } catch {
    return null
  }
}

/** Cyan `[test]`-prefixed status line for any lifecycle event the
 *  user might want to see. Centralized so the visual style stays
 *  consistent across the command's phases. */
function logStatus(message: string): void {
  console.log(chalk`{cyan [test]} ${message}`)
}

export async function testCommand(opts: TestCommandOptions): Promise<void> {
  const projectRoot = resolve(opts.path)

  printSplash()

  // Load the test manifest before doing any host work — without it we
  // can't tell passing tests from missing ones, so the command is
  // meaningless.
  const manifest = await loadTestsManifest(projectRoot)
  if (!manifest) {
    console.error(
      chalk`{red Error:} Test manifest not found. Run {gray \`sand build --test\`} to generate tests, then retry.`,
    )
    process.exit(2)
  }

  // Host-type resolution (same rules as `sand run`).
  const endpoint = await readEndpoint(projectRoot)
  const daemonAlive = !!(endpoint && (await pidAlive(endpoint.pid)))
  if (daemonAlive && endpoint) {
    logStatus(chalk`Using existing \`sand connect\` daemon at {cyan ${endpoint.url}}`)
  } else {
    logStatus(chalk`Bootstrapping {bold ${opts.hostType ?? DEFAULT_HOST_TYPE}} host...`)
  }

  let hostType: HostType | undefined
  if (opts.hostType) {
    if (opts.hostType.includes(',')) {
      console.error(
        chalk`{red Error:} Only one --host-type is supported, got '${opts.hostType}'. Composite daemons were removed.`,
      )
      process.exit(2)
    }
    hostType = opts.hostType as HostType
  }
  const userProvidedHostSettings = !!opts.hostType || !!opts.hostConfig || !!opts.hostConfigFile
  if (!daemonAlive) {
    if (!hostType) hostType = DEFAULT_HOST_TYPE
    if (!KNOWN_HOST_TYPES.has(hostType as HostType)) {
      console.error(chalk`{red Error:} Unknown --host-type '${hostType}'`)
      process.exit(2)
    }
    if (opts.hostConfig && opts.hostConfigFile) {
      console.error(chalk`{red Error:} Pass either --host-config or --host-config-file, not both`)
      process.exit(2)
    }
    if (!opts.hostConfig && !opts.hostConfigFile) {
      opts.hostConfig = JSON.stringify({})
    }
  }
  const resolvedHostType: HostType = hostType ?? DEFAULT_HOST_TYPE

  if (daemonAlive && endpoint) {
    await runDaemon(endpoint, manifest)
    return
  }

  await runDirect(projectRoot, resolvedHostType, opts, userProvidedHostSettings, manifest)
}

// ---------------------------------------------------------------------------
// Shared test session
// ---------------------------------------------------------------------------

/**
 * Transport-agnostic handle for running a single test session. Both the
 * `sand connect` daemon path (which uses a WS `Client`) and the direct
 * path (which uses a `HostProvider`) build a thin session that exposes
 * just the operations the test runner needs: attach to the server log,
 * send the raw console command, and clean up.
 *
 * Keeping this surface narrow is what lets `runSession` be a single
 * implementation shared between both modes — every lifecycle event
 * (attach, send, batch start/complete, summary) lives in one place.
 */
interface TestSession {
  /** Subscribe to server log lines. Lines arrive in chunks split on `\n`. */
  attachLog(handler: LogChunkHandler): Promise<LogSubscription>
  /** Send `test run *:*` and resolve when the host accepts it. */
  executeRawCommand(): Promise<unknown>
  /** Unattach any active subscription and release the host. */
  cleanup(): Promise<void>
}

/**
 * Run the actual test session against any transport. Owns the
 * collection state, the tail window, the summary render, and the exit
 * code; `runDaemon`/`runDirect` just produce the right `TestSession`
 * adapter for their transport and forward into it.
 */
async function runSession(session: TestSession, manifest: TestsManifest): Promise<number> {
  const startMs = Date.now()
  const state: CollectionState = { collecting: false, triggers: 0, completes: 0, failures: [] }

  // Drive completion off the log stream itself: when a chunk arrives that
  // contains the closing marker, resolve. No polling, no intervals —
  // the work finishes the moment the server tells us it did.
  let resolveComplete!: () => void
  const completed = new Promise<void>((resolve) => {
    resolveComplete = resolve
  })

  const subscription = await session.attachLog((lines) => {
    for (const line of lines) {
      processLine(line, state, manifest)
      if (stripMinecraftPrefix(line).includes(COMPLETE_PREFIX) && state.triggers > 0) {
        resolveComplete()
      }
    }
  })
  logStatus(chalk`Running tests...`)
  const cmdPromise = session.executeRawCommand().catch(() => undefined)

  let exitCode = 0
  try {
    await completed
    printSummary(makeSummary(state, true), manifest, Date.now() - startMs)
    exitCode = state.failures.some((f) => !f.optional) ? 1 : 0
    await cmdPromise.catch(() => {})
  } catch (err) {
    console.error(
      chalk`{red Error:} ${err instanceof Error ? err.message : String(err)}`,
    )
    exitCode = 1
  } finally {
    await subscription.unattach().catch(() => {})
    await session.cleanup()
  }
  return exitCode
}

// ---------------------------------------------------------------------------
// Daemon-mode fast path
// ---------------------------------------------------------------------------

async function runDaemon(
  endpoint: NonNullable<Awaited<ReturnType<typeof readEndpoint>>>,
  manifest: TestsManifest,
): Promise<void> {
  const client = await openClient({ endpoint })
  if (!client.welcome.capabilities.executeRawCommand) {
    console.error(chalk`{red Error:} Host does not support executeRawCommand`)
    client.close()
    process.exit(2)
  }
  if (!client.welcome.capabilities.attachLog) {
    console.error(chalk`{red Error:} Host does not support attachLog`)
    client.close()
    process.exit(2)
  }

  process.exit(
    await runSession(
      {
        attachLog: async (handler) => client.attachLog().then((sub) => {
          sub.onLines((lines) => handler(lines))
          return sub
        }),
        executeRawCommand: () => client.executeRawCommand({ command: TEST_COMMAND }),
        cleanup: () => {
          client.close()
          return Promise.resolve()
        },
      },
      manifest,
    ),
  )
}

// ---------------------------------------------------------------------------
// Direct-mode path
// ---------------------------------------------------------------------------

async function runDirect(
  projectRoot: string,
  resolvedHostType: HostType,
  opts: TestCommandOptions,
  userProvidedHostSettings: boolean,
  manifest: TestsManifest,
): Promise<void> {
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
    console.error(chalk`{red Error:} ${msg}`)
    process.exit(2)
  }

  if (!host.capabilities.has('executeRawCommand')) {
    console.error(chalk`{red Error:} Host '${resolvedHostType}' does not support executeRawCommand`)
    await safeDisconnect(host)
    process.exit(2)
  }
  if (!host.capabilities.has('attachLog') || !host.attachLog) {
    console.error(chalk`{red Error:} Host '${resolvedHostType}' does not support attachLog`)
    await safeDisconnect(host)
    process.exit(2)
  }

  process.exit(
    await runSession(
      {
        attachLog: (handler) => host.attachLog!(handler),
        executeRawCommand: () => host.executeRawCommand!(TEST_COMMAND),
        cleanup: async () => {
          if (weStarted && host.type === 'integrated' && host.stopServer && host.capabilities.has('stopServer')) {
            logStatus('Stopping server...')
            await host.stopServer().catch(() => {})
          }
          await safeDisconnect(host)
        },
      },
      manifest,
    ),
  )
}

// ---------------------------------------------------------------------------
// Collection state + line processing
// ---------------------------------------------------------------------------

interface CollectionState {
  collecting: boolean
  /** Number of `Running test environment …` lines seen total. */
  triggers: number
  /** Number of `Game Test complete!` lines seen total. */
  completes: number
  failures: ParsedFailureLog[]
}

function processLine(
  line: string,
  state: CollectionState,
  manifest: TestsManifest,
): void {
  if (line.includes(TRIGGER_PREFIX)) {
    state.collecting = true
    state.triggers++
    return
  }
  if (line.includes(COMPLETE_PREFIX)) {
    state.collecting = false
    state.completes++
    return
  }
  if (!state.collecting) return
  const parsed = parseFailureLog(line)
  if (!parsed) return
  state.failures.push(parsed)
  const entry = manifest.tests.find((t) => t.name === parsed.source)
  const optional = parsed.optional || entry?.optional === true
  console.log(formatTestLine(entry, parsed, optional, manifest.throwables))
}

interface Summary {
  triggers: number
  completes: number
  failures: ParsedFailureLog[]
  requiredCount: number
  optionalCount: number
  completed: boolean
}

function makeSummary(state: CollectionState, completed: boolean): Summary {
  let required = 0
  let optional = 0
  for (const f of state.failures) {
    if (f.optional) optional++
    else required++
  }
  return {
    triggers: state.triggers,
    completes: state.completes,
    failures: state.failures,
    requiredCount: required,
    optionalCount: optional,
    completed,
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Render the trailing header line of a test result — glyph + namespaced
 * id + optional annotation + description + tick. Shared by the
 * live-printed `formatTestLine` (which prepends stack frames) and the
 * brief recap (`formatFailureBrief`, which omits frames entirely).
 *
 * `passed` drives the glyph (passing tests always get ✓ regardless of
 * whether they're marked optional). `optional` only controls the
 * `(optional)` annotation and the brief recap's overall outcome.
 */
function formatTestHeader(
  entry: TestEntry | undefined,
  source: string,
  passed: boolean,
  optional: boolean,
  tick: number | null,
): string {
  let header = ''
  header += passed ? chalk`{green ✔} ` : chalk`{red ✗} `
  header += chalk`{yellowBright ${source}}`
  if (optional) header += chalk` {gray (optional)}`
  header += chalk` {gray >} `
  header += entry?.description ? chalk`{bold ${entry.description}}` : '(no description)'
  if (tick !== null) header += chalk` {gray [${tick}t]}`
  return header
}

function formatTestLine(
  entry: TestEntry | undefined,
  failure: ParsedFailureLog,
  optional: boolean,
  throwables: Record<string, ThrowableEntry>,
): string {
  // Match a runtime line back to the source-level throwable that
  // produced it. `throwableStack` keys are `${source}@${command}:${srcLine}`;
  // the runtime parser only knows the source + line, so pick any entry
  // whose prefix + `:${failure.line}` suffix lines up. If two commands
  // share a line (rare) we keep the first one — the user can disambiguate
  // by looking at the source line.
  let throwableKey: string | undefined
  const prefix = `${failure.source}@`
  const suffix = `:${failure.line}`
  for (const key of Object.keys(throwables)) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      throwableKey = key
      break
    }
  }
  const throwable = throwableKey !== undefined ? throwables[throwableKey] : undefined

  // Assemble each "frame" into a list, then prepend the stack-trace
  // header (error / pos / runtime-at) and append the test header. The
  // brief recap reuses `formatTestHeader` without the frames.
  const frames: string[] = []
  frames.push(chalk`\n{red error}{gray :} {bold ${failure.message}}`)
  frames.push(chalk`\n  pos{gray :} {greenBright ${failure.x} ${failure.y} ${failure.z}}{gray ,}\n`)

  let runtimeFrame = chalk`\n${' '.repeat(6)}{gray at} {bold {italic ${throwable?.command ?? `<anonymous>`}}} `
  const [namespace, id] = failure.source.split(':')
  runtimeFrame += chalk`{gray (}{blue ${join(process.cwd(), '.sandstone', 'output', 'datapack', 'data')}${path.sep}}`
  runtimeFrame += chalk`{cyan ${namespace}${path.sep}test${path.sep}${id.replaceAll('/', path.sep)}.mcfunction}`
  runtimeFrame += chalk`{gray :}{yellowBright ${failure.line}}{gray :}{yellow 0}{gray )}`
  frames.push(runtimeFrame)

  if (throwable?.trace?.file) {
    let traceFrame = chalk`\n${' '.repeat(6)}{gray at} {bold {italic Test#create}} `
    const cwd = `${process.cwd()}${path.sep}`
    traceFrame += chalk`{gray (}{blue ${cwd}}`
    traceFrame += chalk`{cyan ${throwable.trace.file.replace(cwd, '')}}`
    traceFrame += chalk`{gray :}{yellowBright ${throwable.trace.line}}{gray :}{yellow ${throwable.trace.column}}{gray )}\n`
    frames.push(traceFrame)
  }

  return frames.join('') + '\n' + formatTestHeader(entry, failure.source, optional, optional, failure.tick)
}

/**
 * Single-line recap of a failure, no stack frames. Used by the end-of-run
 * summary so each failure appears once compactly without duplicating the
 * full live-printed stack. Shares its header rendering with the live
 * print via {@link formatTestHeader}.
 */
function formatFailureBrief(
  entry: TestEntry | undefined,
  failure: ParsedFailureLog,
  optional: boolean,
): string {
  const elapsedPart = '' // hook for per-test timing once PackTest reports it
  return '\n' + formatTestHeader(entry, failure.source, optional, optional, failure.tick) + elapsedPart
}

/**
 * Single-line rendering for a passing test. Mirrors {@link formatTestHeader}
 * shape (same glyph + name + optional + description slot) so the summary
 * block reads consistently whether the test passed or failed.
 */
function formatPassLine(entry: TestEntry, optional: boolean): string {
  return '\n' + formatTestHeader(entry, entry.name, true, optional, null)
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(2)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function printSummary(
  summary: Summary,
  manifest: TestsManifest,
  elapsedMs: number,
): void {
  // Bucket tests by outcome. A test that emitted any failure is a
  // "fail" — the brief recap picks the first as the canonical failure so
  // we don't list a single test multiple times.
  const failureBySource = new Map<string, ParsedFailureLog>()
  for (const f of summary.failures) {
    if (!failureBySource.has(f.source)) failureBySource.set(f.source, f)
  }
  const failedSources = new Set(failureBySource.keys())

  // Passes first so the failing block reads as a self-contained delta.
  for (const t of manifest.tests) {
    if (failedSources.has(t.name)) continue
    console.log(formatPassLine(t, t.optional === true))
  }

  // Header + failure recap (no frames).
  if (summary.failures.length > 0) {
    const header = failedSources.size === 1 ? '1 test failed:' : `${failedSources.size} tests failed:`
    console.log(chalk`\n{red ${header}}`)
    for (const t of manifest.tests) {
      const failure = failureBySource.get(t.name)
      if (!failure) continue
      const entry = manifest.tests.find((m) => m.name === t.name)
      const optional = t.optional === true || failure.optional
      console.log(formatFailureBrief(entry, failure, optional))
    }
  }

  // Vitest-style totals footer.
  const total = manifest.tests.length
  const fail = failedSources.size
  const pass = total - fail
  // Count distinct source files from the manifest entries — every test
  // reports its defining file, so passing tests count too (unlike the
  // throwables-based count which only sees fallable tests).
  const fileCount = new Set(manifest.tests.map((t) => t.sourceFile ?? '')).size
  let line = ''
  line += chalk`\n {green ${pass} pass}`
  line += chalk`\n {${fail === 0 ? 'gray' : 'red'} ${fail} fail}`
  line += chalk`\nRan ${total} test${total === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}. {gray [${formatMs(elapsedMs)}]}`
  console.log(line)

  if (!summary.completed) {
    console.log(
      chalk`{yellow [test]} no \`Game Test complete!\` marker seen after ${summary.triggers} batch start${summary.triggers === 1 ? '' : 's'}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

async function safeDisconnect(host: HostProvider): Promise<void> {
  try {
    await host.disconnect()
  } catch {}
}