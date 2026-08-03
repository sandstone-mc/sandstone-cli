import { mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const CLI = join(__dirname, '..')
export const SANDBIN = join(CLI, 'lib', 'index.js')
export const TESTRUNS = join(CLI, '.test-runs')

/** ShellLine mirrors the template's helper at sandstone-template/test/index.test.ts. */
export class ShellLine {
  constructor(
    public rawLine: string,
    public i: number,
    public chunkI: number,
    public lines: number,
  ) {}

  /** Strip ANSI escape codes from the line. */
  get line(): string {
    return this.rawLine.replace(/\[.*?m/g, '')
  }
}

/** Spawn a CLI process and yield its stdout lines as ShellLine objects. */
export async function* spawnCli(
  args: string[],
  opts: { cwd?: string; extraEnv?: Record<string, string> } = {},
): AsyncGenerator<ShellLine, { exitCode: number }, void> {
  const proc = Bun.spawn({
    cmd: ['bun', SANDBIN, ...args],
    cwd: opts.cwd ?? process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0', ...(opts.extraEnv ?? {}) },
    windowsHide: true,
    windowsVerbatimArguments: true,
  })

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let globalI = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (let i = 0; i < lines.length; i++) {
      yield new ShellLine(lines[i], globalI++, i, lines.length)
    }
  }
  if (buf.length > 0) yield new ShellLine(buf, globalI++, 0, 1)

  const exitCode = await proc.exited
  return { exitCode }
}

/**
 * Spawn a CLI command to completion, returning its combined output and
 * exit code. Use for non-interactive commands (`link`, `unlink`, `build`).
 */
export async function runSand(args: string[], cwd: string): Promise<{ output: string; exitCode: number }> {
  let proc: ReturnType<typeof Bun.spawn> | undefined
  try {
    proc = Bun.spawn({
      cmd: ['bun', SANDBIN, ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
      windowsHide: true,
      windowsVerbatimArguments: true,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { output: stdout + stderr, exitCode }
  } catch (err) {
    const e = err as { status?: number }
    return { output: '', exitCode: e.status ?? 1 }
  }
}

/** Drive `create-sandstone` via the existing test harness. */
export async function harnessCreate(name: string, isLibrary: boolean): Promise<string> {
  if (existsSync(join(TESTRUNS, name))) await rm(join(TESTRUNS, name), { recursive: true, force: true })
  // Library: 5 prompts (confirm, version, npm package name, save, pm).
  // Pack: 6 (confirm, version, pack name, namespace, save, pm).
  const responses = isLibrary
    ? JSON.stringify([
        ['y', 'enter'],                          // library?
        ['enter'],                              // sandstone version
        ['@test-scope/my-lib', 'enter'],         // npm package name (scoped)
        ['down', 'down', 'down', 'enter'],      // save location: N/A
        ['enter'],                              // package manager
      ])
    : JSON.stringify([
        ['n', 'enter'],
        ['enter'],
        ['enter'],            // pack name (default = project name)
        ['enter'],            // namespace
        ['down', 'down', 'down', 'enter'],
        ['enter'],
      ])
  const cmd = `bun test:harness create ${name} --responses '${responses}'`
  const proc = Bun.spawn({
    cmd: ['bash', '-lc', cmd],
    cwd: CLI,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  await proc.exited
  return join(TESTRUNS, name, name)
}

/** Reset the test-runs directory at the start of a suite. */
export async function resetTestRuns(): Promise<void> {
  if (existsSync(TESTRUNS)) await rm(TESTRUNS, { recursive: true, force: true })
  await mkdir(TESTRUNS, { recursive: true })
}

/** Clean up after a suite. */
export async function cleanupTestRuns(): Promise<void> {
  await runSand(['test:harness', 'cleanup'], CLI)
  if (existsSync(TESTRUNS)) await rm(TESTRUNS, { recursive: true, force: true })
}

/** Async directory walk. */
export async function walk(dir: string, pred: (p: string) => Promise<boolean> | boolean): Promise<string[]> {
  const out: string[] = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (await pred(p)) out.push(p)
    }
  }
  return out
}

/** Find any .mcfunction in the pack output containing a marker. */
export async function findOutputWithMarker(root: string, marker: string): Promise<string | null> {
  const files = await walk(root, (p) => p.endsWith('.mcfunction'))
  for (const f of files) {
    if ((await readFile(f, 'utf-8')).includes(marker)) return f
  }
  return null
}

/** Spawn a watch process inside a PTY so Ink doesn't crash. */
export function spawnWatch(args: string[], cwd: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn({
    cmd: ['script', '-qfc', `bun ${SANDBIN} ${args.join(' ')}`, '/dev/null'],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0', TERM: 'xterm-256color' },
  })
}

// --- Domain helpers -------------------------------------------------------

/** Run `bun dev:build` inside a library (compiles + typechecks). */
export async function buildLibrary(libDir: string): Promise<{ output: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ['bun', 'run', 'dev:build'],
    cwd: libDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { output: stdout + stderr, exitCode }
}

/**
 * Rebuild a library and repack it so consumers pick up the change.
 * Chain: bun dev:build → sand link.
 */
export async function rebuildAndRepackLibrary(libDir: string): Promise<void> {
  await buildLibrary(libDir)
  await runSand(['link'], libDir)
}

/** Write the library's `src/display.ts` so it emits a unique MCFunction marker. */
export async function writeLibraryMarker(libDir: string, libName: string, marker: string): Promise<void> {
  const displayTs = `import { MCFunction, tellraw } from 'sandstone'\n\nexport const displayMessage = () => MCFunction('display_message', () => {\n  tellraw('@a', [${JSON.stringify(marker)}])\n})\n`
  await writeFile(join(libDir, 'src', 'display.ts'), displayTs)
  await writeFile(join(libDir, 'src', 'index.ts'), `export { displayMessage } from './display.js'\n`)
}

/** Write the pack's `src/display.ts` to call the library's displayMessage. */
export async function writePackCaller(packDir: string, libName: string): Promise<void> {
  await writeFile(join(packDir, 'src', 'display.ts'), `import { displayMessage } from '${libName}'\ndisplayMessage()\n`)
}

export { existsSync, join }