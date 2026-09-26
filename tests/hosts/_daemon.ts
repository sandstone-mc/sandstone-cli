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
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Imported from `src/` (with type declarations) rather than the
// bundled `lib/index.js` (no .d.ts emitted by `bun bundle`). Bun
// runs the same TypeScript directly, so this exercises the same
// client code the daemon uses internally.
import { connect as openClient, type Client } from '../../src/commands/connect/client.ts'

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