/**
 * Shell command wrappers.
 *
 * The CLI now has a hard dependency on Bun, so all subprocess invocations
 * route through here. Two shapes are exposed:
 *
 *   - `sh(cmd, opts)` — bash-string command. Uses `Bun.spawn(['sh', '-c', cmd])`
 *     so the command is parsed and tokenized by POSIX sh (same as
 *     `child_process.execSync`). Default behavior is `.quiet()` +
 *     `.nothrow()`: stdout/stderr are captured, not printed, and a non-zero
 *     exit code does NOT throw. The caller decides what to do with the
 *     exit code. Use this for plumbing (`git clone`, `${pm} install`,
 *     `rm -rf ...`) where piping/globs/env vars are useful.
 *
 *     We don't use Bun Shell's `$\`${cmd}\`` here because string
 *     interpolation escapes the entire string as a single argument —
 *     `$\`${"git clone X"}\`` tries to exec a binary literally named
 *     `git clone X`. POSIX sh via spawn handles the parsing correctly.
 *
 *   - `run(cmd, args, opts)` — argv-style. Uses `Bun.spawn` directly. Same
 *     quiet defaults, but no shell parsing — argv is passed directly. Use
 *     this when command/args come from user input (avoids shell injection)
 *     or when the caller wants stdio=inherit to forward a child's output.
 *
 * Both return `ShellResult` with **lazy** `stdout` / `stderr` Promise
 * getters. Streams aren't drained until you actually `await` one of them,
 * so a CLI that only checks `exitCode` (e.g. `hasYarn()`) pays zero I/O
 * cost for stdout/stderr.
 *
 * For interactive subprocesses (e.g. `git add -p`), call `run` with
 * `stdio: 'inherit'` so the user sees output and the CLI doesn't deadlock
 * waiting for a TTY it isn't attached to.
 */
import { type Subprocess } from 'bun'

export type StdioMode = 'inherit' | 'pipe'

// A captured stream handle from a Bun.spawn in pipe mode. In inherit mode
// the slot is `undefined`; in raw fd mode it's a number. We narrow at use.
type CapturedStream = ReadableStream<Uint8Array<ArrayBuffer>> | number | undefined

/**
 * Lazy result of a spawned command. `exitCode` is populated as soon as
 * the subprocess exits; `stdout` / `stderr` are drained only on first
 * access (and cached for subsequent accesses).
 */
export class ShellResult {
  readonly exitCode: number
  private readonly _stdout: CapturedStream
  private readonly _stderr: CapturedStream
  private _stdoutPromise?: Promise<Buffer>
  private _stderrPromise?: Promise<Buffer>

  constructor(
    exitCode: number,
    stdout: CapturedStream,
    stderr: CapturedStream,
  ) {
    this.exitCode = exitCode
    this._stdout = stdout
    this._stderr = stderr
  }

  /** Drain stdout into a Buffer. Cached. No-op if the stream was already consumed. */
  get stdout(): Promise<Buffer> {
    if (!this._stdoutPromise) {
      this._stdoutPromise = drainStream(this._stdout)
    }
    return this._stdoutPromise
  }

  /** Drain stderr into a Buffer. Cached. No-op if the stream was already consumed. */
  get stderr(): Promise<Buffer> {
    if (!this._stderrPromise) {
      this._stderrPromise = drainStream(this._stderr)
    }
    return this._stderrPromise
  }
}

async function drainStream(s: CapturedStream): Promise<Buffer> {
  if (s === undefined || typeof s === 'number') {
    // `inherit` (undefined) or raw fd mode — nothing to drain.
    return Buffer.alloc(0)
  }
  return Buffer.from(await new Response(s).arrayBuffer())
}

export type ShellOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Forward a child process's stdio to the CLI's stdio. Use for interactive commands. */
  stdio?: StdioMode
  /** Throw on non-zero exit. Default: false. */
  throws?: boolean
}

export async function sh(cmd: string, opts: ShellOptions = {}): Promise<ShellResult> {
  const result = await spawnSh(cmd, opts)
  if (opts.throws !== false && result.exitCode !== 0) {
    const stderr = await result.stderr
    const stdout = await result.stdout
    throw new Error(`Command "${cmd}" failed in ${opts.cwd ?? process.cwd()} (exit ${result.exitCode}):\n${stderr.toString() || stdout.toString()}`)
  }
  return result
}

export type RunOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdio?: StdioMode
  throws?: boolean
}

export async function run(
  cmd: string,
  args: string[] = [],
  opts: RunOptions = {},
): Promise<ShellResult> {
  const result = await spawnArgv([cmd, ...args], opts)
  if (opts.throws !== false && result.exitCode !== 0) {
    const stderr = await result.stderr
    const stdout = await result.stdout
    throw new Error(`Command "${cmd} ${args.join(' ')}" failed in ${opts.cwd ?? process.cwd()} (exit ${result.exitCode}):\n${stderr.toString() || stdout.toString()}`)
  }
  return result
}

/**
 * Internal: spawn `sh -c <cmd>` and return a lazy ShellResult.
 */
async function spawnSh(cmd: string, opts: ShellOptions): Promise<ShellResult> {
  return spawnArgv(['sh', '-c', cmd], opts)
}

/**
 * Internal: spawn an argv array (no shell parsing) and return a lazy
 * ShellResult. Centralized so the stdio mapping + lazy-result construction
 * stay in one place.
 */
async function spawnArgv(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: StdioMode }): Promise<ShellResult> {
  // Bun's stdio type is a 4-tuple [stdin, stdout, stderr, ...extra]. The
  // first three positions are required; extra channels (≥4) are optional.
  // We only ever set the first three, so cast to the fixed 3-tuple.
  type Stdio = ['inherit' | 'pipe' | 'ignore', 'inherit' | 'pipe' | 'ignore', 'inherit' | 'pipe' | 'ignore', ...('inherit' | 'pipe' | 'ignore')[]]
  const stdio: Stdio = opts.stdio === 'inherit'
    ? ['inherit', 'inherit', 'inherit']
    : ['ignore', 'pipe', 'pipe']
  const subprocess: Subprocess = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio,
  })
  // Wait for exit so `exitCode` is populated; reading the streams later
  // (via the lazy getters) still works because they were captured in
  // `pipe` mode above.
  const exitCode = await subprocess.exited
  return new ShellResult(exitCode, subprocess.stdout, subprocess.stderr)
}

/**
 * Return true if a command exists on PATH. Uses `Bun.which` (sync) because
 * this is called from setup paths that want to gate a prompt on tool
 * presence before bothering the user.
 */
export function hasCommand(cmd: string): boolean {
  return Bun.which(cmd) !== null
}

/**
 * Return the resolved path of a command on PATH, or null if not found.
 */
export function which(cmd: string): string | null {
  return Bun.which(cmd)
}

/**
 * Re-export `Bun.spawn` so callers that need fine-grained control over a
 * Subprocess (event listeners, signal handling) don't have to import from
 * `bun` directly. Centralizes the import surface.
 */
export function spawn(argv: string[], opts: Parameters<typeof Bun.spawn>[1] = {}): Subprocess {
  return Bun.spawn(argv, opts)
}
