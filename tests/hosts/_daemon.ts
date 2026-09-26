/**
 * Helpers for the host-provider end-to-end tests under `tests/hosts/`.
 *
 * Each test boots a real `sand connect` daemon that talks to the
 * Docker harness (`tests/docker/`), then drives it via `sand run`.
 * Follows the same pattern the existing `tests/link.test.ts` and
 * `tests/export.test.ts` use for the rest of the CLI: no direct
 * imports of the host providers themselves — everything goes
 * through the bundled CLI as a subprocess.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Imported from `src/` (with type declarations) rather than the
// bundled `lib/index.js` (no .d.ts emitted by `bun bundle`). Bun
// runs the same TypeScript directly, so this exercises the same
// client code the daemon uses internally.
import { connect as openClient, type Client } from '../../src/commands/connect/client.ts'
import type { HarnessConfig } from './_harness.ts'

export type { HarnessConfig }

const __dirname = join(fileURLToPath(import.meta.url), '..', '..', '..')
export const CLI_ROOT = __dirname
export const SANDBIN = join(CLI_ROOT, 'lib', 'index.js')

export interface DaemonOptions {
  /** Temp project root. The daemon writes `.sandstone/connect.url`
   * here. Caller is responsible for cleanup. */
  projectRoot: string
  /** Comma-separated list of host types, e.g. `'ssh,rcon'` or `'ftp'`. */
  hostType: string
  /** Host config JSON (keyed map for composite, flat for single). */
  hostConfig: string
  /** WS bind address. Default 127.0.0.1. */
  bind?: string
  /** WS bind port. Default 0 (OS-assigned). */
  port?: number
  /** Extra env vars to pass to the daemon. */
  extraEnv?: Record<string, string>
}

export interface RunningDaemon {
  /** The bun subprocess running the daemon. Kill via `proc.kill()`. */
  proc: Bun.Subprocess
  /** Path to the endpoint file. */
  endpointPath: string
  /** Bound port once the endpoint file is read. */
  port: number
  /** Daemon URL as written into the endpoint file. */
  url: string
  /** Cleanly shutdown the daemon via `sand connect --shutdown`. */
  shutdown: () => Promise<{ exitCode: number }>
}

/**
 * Boot a `sand connect` daemon in a background subprocess and wait
 * for it to write `.sandstone/connect.url` (signals "ready").
 *
 * The daemon's stdout/stderr are discarded by default — pipe them
 * elsewhere if a test needs to debug.
 */
export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const { projectRoot, hostType, hostConfig, bind = '127.0.0.1', port = '0', extraEnv = {} } = opts
  await mkdir(join(projectRoot, '.sandstone'), { recursive: true })
  const portStr = String(port)

  const cmd: string[] = [
    Bun.which('bun') ?? 'bun',
    SANDBIN,
    'connect',
    '--path', projectRoot,
    '--host-type', hostType as string,
    '--host-config', hostConfig as string,
    '--bind', bind as string,
    '--port', portStr,
  ]
  const proc = Bun.spawn({
    cmd,
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0', ...extraEnv },
    windowsHide: true,
    windowsVerbatimArguments: true,
  })

  const endpointPath = join(projectRoot, '.sandstone', 'connect.url')

  // Poll for the endpoint file. The daemon writes it once the WS
  // server is listening and the host has been constructed (but not
  // necessarily connected yet — `connect()` runs lazily on the
  // first RPC call).
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(endpointPath)) break
    if (proc.exitCode !== null) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`daemon exited early (code ${proc.exitCode}):\n${stderr}`)
  }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!existsSync(endpointPath)) {
    // Surface daemon stderr so failures are debuggable from the test log.
    const stderr = await new Response(proc.stderr).text()
    proc.kill()
    throw new Error(`daemon did not write endpoint file within 30s.\nstderr:\n${stderr}`)
  }

  const endpointRaw = readFileSync(endpointPath, 'utf8').trim()
  // The endpoint file is JSON: `{ "url": "ws://127.0.0.1:<port>", ... }`
  const endpoint = JSON.parse(endpointRaw) as { url?: string; port?: number }
  const url = endpoint.url ?? ''
  const boundPort = endpoint.port ?? -1

  const shutdown = async () => {
    const r = Bun.spawn({
      cmd: [Bun.which('bun') ?? 'bun', SANDBIN, 'connect', '--path', projectRoot, '--shutdown'],
      cwd: projectRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    const code = await r.exited
    // Give the daemon process a moment to exit cleanly before we
    // hard-kill (best-effort).
    try {
      proc.kill('SIGTERM')
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 2_000))])
    } catch {
      // Already gone.
    }
    return { exitCode: code }
  }

  return { proc, endpointPath, port: boundPort, url, shutdown }
}

/** Best-effort cleanup of a temp project root. */
export async function cleanupProject(projectRoot: string): Promise<void> {
  await rm(projectRoot, { recursive: true, force: true })
}

/** Run `sand run <args...>` to completion. Returns combined output + exit code. */
export async function runSand(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<{ output: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [Bun.which('bun') ?? 'bun', SANDBIN, 'run', ...args, '--path', cwd],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0', ...extraEnv },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { output: stdout + stderr, exitCode }
}

/**
 * Open a WebSocket client against an already-running daemon's
 * endpoint. Returns the typed RPC client + a close function.
 *
 * Use this to exercise `readFile`, `writeFile`, `attachLog`, etc.
 * directly — useful when the host under test (FTP) has no
 * `executeRawCommand`, so `sand run` can't drive it.
 */
export async function openDaemonClient(daemon: RunningDaemon): Promise<Client> {
  const endpointRaw = readFileSync(daemon.endpointPath, 'utf8').trim()
  const endpoint = JSON.parse(endpointRaw) as Parameters<typeof openClient>[0]['endpoint']
  return await openClient({ endpoint })
}

// ---------------------------------------------------------------------------
// Docker harness lifecycle (tests/hosts/host.test.ts imports these)
// ---------------------------------------------------------------------------

export const COMPOSE_FILE = 'tests/docker/docker-compose.yml'
export const CONTAINER = 'sandstone-cli-host-test'
export const SSH_KEY_HOST_PATH = '/home/mctest/.ssh/id_ed25519'
export const SSH_KEY_TEST_PATH = resolve('.temp/test-harness/ssh-key')

function log(step: string, msg = ''): void {
  const ts = new Date().toISOString().slice(11, 19)
  process.stdout.write(`[host.test ${ts}] ${step}${msg ? `: ${msg}` : ''}\n`)
}

async function dockerCompose(...args: string[]): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', '-f', COMPOSE_FILE, ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} exited ${code}`)
  }
}

/** Poll until the harness healthcheck flips to healthy or the deadline hits. */
export async function waitForHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let poll = 0
  while (Date.now() < deadline) {
    poll++
    const proc = Bun.spawn(
      ['docker', 'inspect', '--format', '{{.State.Health.Status}}', 'sandstone-cli-host-test'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const status = out.trim()
    log('health', `poll ${poll}: status=${status || 'unknown'}`)
    if (status === 'healthy') return
    if (status && status !== 'starting') {
      throw new Error(`harness container is unhealthy: ${status}`)
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error(`harness did not become healthy within ${timeoutMs}ms`)
}

/** Poll MC's logs for the "Done (" line so the JVM is truly ready. */
export async function waitForMcBoot(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const proc = Bun.spawn(
      ['docker', 'compose', '-f', COMPOSE_FILE, 'logs', '--no-color', '--no-log-prefix', 'mc'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    if (/Done \(/.test(out)) {
      log('mc-boot', 'detected "Done (" — booted')
      return
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error(`Minecraft did not finish booting within ${timeoutMs}ms`)
}

/** Pull the SSH private key out of the harness into `.temp/test-harness/`. */
export async function copySshKey(): Promise<void> {
  mkdirSync(dirname(SSH_KEY_TEST_PATH), { recursive: true })
  await dockerCompose('cp', `mc:${SSH_KEY_HOST_PATH}`, SSH_KEY_TEST_PATH)
  await Bun.spawn(['chmod', '600', SSH_KEY_TEST_PATH]).exited
}

/**
 * Suite-scoped flag set by `ensureHarnessUp`. When `true`, we
 * brought the harness up ourselves and are responsible for tearing
 * it down — `teardownHarnessIfOurs` will honor that. When `false`,
 * the harness was already running (or we skipped entirely) and we
 * leave it alone.
 */
export let harnessBroughtUp = false
export function setHarnessBroughtUp(value: boolean): void {
  harnessBroughtUp = value
}

/**
 * Bring the harness up. Auto-detects whether it's already running:
 *
 * - `TEST_SKIP_HARNESS=1` → assume up, don't touch anything. Used for
 *   fast local iteration against a harness the user is managing
 *   manually.
 * - Already healthy → leave alone, don't tear down later.
 * - Anything else (missing / stopped / starting) → bring it up from
 *   scratch + set `harnessBroughtUp = true` so `teardownHarness`
 *   cleans up.
 *
 * Throws on build / start failures.
 */
export async function ensureHarnessUp(): Promise<void> {
  if (process.env.TEST_SKIP_HARNESS === '1') {
    log('harness', 'TEST_SKIP_HARNESS=1 — assuming harness is already up')
    return
  }
  const state = await probeHarnessState()
  if (state === 'healthy') {
    log('harness', `already ${state} — leaving alone`)
    return
  }
  log('harness', `state=${state}, bringing up`)
  await dockerCompose('up', '-d', '--build')
  await waitForHealthy(180_000) // MC cold start + asset download
  await waitForMcBoot(30_000)
  await copySshKey()
  setHarnessBroughtUp(true)
}

/**
 * Teardown counterpart to `ensureHarnessUp`. Only tears down when
 * `harnessBroughtUp` is true (i.e. we brought it up — so we own
 * the lifecycle). If the harness was user-managed or TEST_SKIP_HARNESS
 * was set, this is a no-op.
 */
export async function teardownHarness(): Promise<void> {
  if (process.env.TEST_SKIP_HARNESS === '1') return
  if (!harnessBroughtUp) {
    log('teardown', 'skipped (we did not start the harness)')
    return
  }
  log('teardown', `docker compose -f ${COMPOSE_FILE} down -v`)
  try {
    await dockerCompose('down', '-v', '--remove-orphans')
  } catch {
    // Already gone — fine.
  }
}

/**
 * Probe the harness container's state via `docker inspect`. Returns a
 * string the suite uses to decide whether `ensureHarnessUp` should
 * actually bring it up or treat it as user-managed.
 *
 * - `missing`  → no container (or `docker inspect` errored)
 * - `stopped`  → container exists but the JVM exited / was removed
 * - `healthy`  → up + healthcheck passed
 * - `starting` / `unhealthy` → mid-startup or failed healthcheck
 */
export async function probeHarnessState(): Promise<
  'missing' | 'stopped' | 'starting' | 'healthy' | 'unhealthy'
> {
  const proc = Bun.spawn(
    [
      'docker',
      'inspect',
      '--format',
      '{{.State.Health.Status}}|{{.State.Status}}',
      CONTAINER,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const [health, state] = out.trim().split('|')
  if (state === 'exited' || state === 'dead' || state === 'removing') return 'stopped'
  if (!state) return 'missing'
  if (health === 'healthy') return 'healthy'
  if (health === 'unhealthy') return 'unhealthy'
  return 'starting'
}