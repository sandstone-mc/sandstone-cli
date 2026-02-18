#!/usr/bin/env bun
/**
 * Test harness for the Sandstone CLI.
 * Uses node-pty to allow pre-programming responses for interactive prompts.
 *
 * Usage:
 *   bun test:harness create [project-name] --responses '<json>'
 *   bun test:harness sand <args...>
 *   bun test:harness cleanup
 *   bun test:harness list
 *
 * Response format (array of keystrokes/text to send):
 *   ["n", "enter"]                    - Type 'n' then press enter (for confirm)
 *   ["enter"]                         - Press enter (accept default)
 *   ["down", "down", "enter"]         - Arrow down twice, then enter (for select)
 *   ["My Pack Name", "enter"]         - Type text then enter (for input)
 *
 * Special keys: enter, up, down, space, tab, escape
 */

import * as pty from 'node-pty'
import { mkdirSync, rmSync, readdirSync, existsSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = join(__dirname, '..')
const CREATE_SCRIPT = join(CLI_ROOT, 'lib', 'create.js')
const SAND_SCRIPT = join(CLI_ROOT, 'lib', 'index.js')
const TEST_RUNS_DIR = join(CLI_ROOT, '.test-runs')

// Handle errors from node-pty by exiting cleanly
process.on('unhandledRejection', (err) => {
  if (err instanceof Error && err.message.includes('Socket is closed')) {
    process.exit(0)
  }
  console.error('Unhandled rejection:', err)
  process.exit(1)
})

process.on('uncaughtException', (err) => {
  if (err.message.includes('Socket is closed')) {
    process.exit(0)
  }
  console.error('Uncaught exception:', err)
  process.exit(1)
})

const KEY_MAP: Record<string, string> = {
  enter: '\r\n',
  up: '\x1B[A',
  down: '\x1B[B',
  right: '\x1B[C',
  left: '\x1B[D',
  space: ' ',
  tab: '\t',
  escape: '\x1B',
  backspace: '\x7F',
}

// Strip ANSI escape codes from text
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B\[\?[0-9;]*[hl]|\x07/g, '')
}

// Clean up output: strip ANSI, normalize whitespace, remove empty lines
function cleanOutput(text: string): string {
  return stripAnsi(text)
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .join('\n')
}

function ensureTestRunsDir(): void {
  if (!existsSync(TEST_RUNS_DIR)) {
    mkdirSync(TEST_RUNS_DIR, { recursive: true })
  }
}

function getTestRunDirs(): string[] {
  if (!existsSync(TEST_RUNS_DIR)) return []
  return readdirSync(TEST_RUNS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(TEST_RUNS_DIR, d.name))
}

function createTestRunDir(name: string): string {
  ensureTestRunsDir()
  const dir = join(TEST_RUNS_DIR, name)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

function parseResponses(responsesJson: string): string[][] {
  try {
    const parsed = JSON.parse(responsesJson)
    if (!Array.isArray(parsed)) {
      throw new Error('Responses must be an array')
    }
    return parsed
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`Failed to parse responses: ${message}`)
    process.exit(1)
  }
}

function keystrokeToBytes(key: string): string {
  return KEY_MAP[key.toLowerCase()] ?? key
}

interface RunResult {
  output: string
  exitCode: number | null
  projectPath?: string
}

async function runWithPty(
  command: string,
  args: string[],
  cwd: string,
  responses: string[][]
): Promise<RunResult> {
  return new Promise((resolve) => {
    const fullCommand = `${command} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`

    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
    const shellArgs = process.platform === 'win32'
      ? ['-NoProfile', '-Command', fullCommand]
      : ['-c', fullCommand]

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'CI') {
        env[key] = value
      }
    }
    env.FORCE_COLOR = '1'
    env.TERM = 'xterm-256color'

    const proc = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
    })

    let responseIndex = 0
    let outputBuffer = ''
    let fullOutput = ''
    let exited = false

    proc.onExit(({ exitCode }) => {
      exited = true
      resolve({ output: fullOutput, exitCode })
    })

    proc.onData((data) => {
      fullOutput += data
      outputBuffer += data

      if (!exited && responseIndex < responses.length && outputBuffer.includes('?')) {
        outputBuffer = ''
        setTimeout(() => {
          if (!exited && responseIndex < responses.length) {
            const response = responses[responseIndex]
            const bytes = response.map(keystrokeToBytes).join('')
            try {
              proc.write(bytes)
            } catch {
              exited = true
              resolve({ output: fullOutput, exitCode: null })
              return
            }
            responseIndex++
          }
        }, 100)
      }
    })

    setTimeout(() => {
      if (!exited) {
        proc.kill()
        resolve({ output: fullOutput + '\n[TIMEOUT]', exitCode: null })
      }
    }, 30000)
  })
}

function writeLog(logPath: string, content: string): void {
  writeFileSync(logPath, content, 'utf-8')
  console.log(`Log written to: ${logPath}`)
}

const commands: Record<string, (args: string[]) => Promise<void> | void> = {
  async create(args) {
    const responsesIdx = args.indexOf('--responses')
    let responses: string[][] = []
    let projectArgs = args

    if (responsesIdx !== -1) {
      const responsesJson = args[responsesIdx + 1]
      responses = parseResponses(responsesJson)
      projectArgs = [...args.slice(0, responsesIdx), ...args.slice(responsesIdx + 2)]
    }

    const projectName = projectArgs[0] || `test-${Date.now()}`
    const remainingArgs = projectArgs.slice(1)

    const testRunDir = createTestRunDir(projectName)
    const projectPath = join(testRunDir, projectName)

    console.log(`Creating project: ${projectName}`)
    console.log(`Directory: ${testRunDir}`)

    const result = await runWithPty('bun', [CREATE_SCRIPT, projectName, ...remainingArgs], testRunDir, responses)

    const cleanedOutput = cleanOutput(result.output)
    const logPath = join(testRunDir, 'test-run.log')

    const logContent = [
      `# Test Run: ${projectName}`,
      `Date: ${new Date().toISOString()}`,
      `Exit Code: ${result.exitCode}`,
      `Project Path: ${projectPath}`,
      '',
      '## Output',
      cleanedOutput,
    ].join('\n')

    writeLog(logPath, logContent)

    console.log(`Exit code: ${result.exitCode}`)
    console.log(`Project: ${projectPath}`)
  },

  async sand(args) {
    const result = await runWithPty('bun', [SAND_SCRIPT, ...args], process.cwd(), [])
    console.log(cleanOutput(result.output))
    console.log(`Exit code: ${result.exitCode}`)
  },

  async run(args) {
    const responsesIdx = args.indexOf('--responses')
    let responses: string[][] = []
    let cmdArgs = args

    if (responsesIdx !== -1) {
      const responsesJson = args[responsesIdx + 1]
      responses = parseResponses(responsesJson)
      cmdArgs = [...args.slice(0, responsesIdx), ...args.slice(responsesIdx + 2)]
    }

    const [cmd, ...rest] = cmdArgs
    const result = await runWithPty(cmd, rest, process.cwd(), responses)
    console.log(cleanOutput(result.output))
    console.log(`Exit code: ${result.exitCode}`)
  },

  cleanup() {
    const dirs = getTestRunDirs()
    if (dirs.length === 0) {
      console.log('No test runs to clean up')
      return
    }

    console.log(`Cleaning up ${dirs.length} test runs:`)
    for (const dir of dirs) {
      console.log(`  - ${dir}`)
      rmSync(dir, { recursive: true, force: true })
    }
    console.log('Done')
  },

  list() {
    const dirs = getTestRunDirs()
    if (dirs.length === 0) {
      console.log('No test runs')
      return
    }

    console.log(`Test runs (${dirs.length}):`)
    for (const dir of dirs) {
      const name = dir.split(/[/\\]/).pop()
      const logExists = existsSync(join(dir, 'test-run.log'))
      console.log(`  ${name}${logExists ? ' (has log)' : ''}`)
    }
  },

  help() {
    console.log(`
Sandstone CLI Test Harness

Commands:
  bun test:harness create [name] [--responses '<json>']
    Create a project with pre-programmed responses
    Output saved to .test-runs/<name>/

  bun test:harness run <cmd> [args...] [--responses '<json>']
    Run arbitrary command with responses

  bun test:harness sand <args...>
    Run sand command

  bun test:harness list
    List test runs in .test-runs/

  bun test:harness cleanup
    Remove all test runs

Response Format:
  [
    ["n", "enter"],           # confirm: type 'n', press enter
    ["enter"],                # select: accept default
    ["down", "down", "enter"],# select: navigate and select
    ["My Pack", "enter"],     # input: type text, press enter
  ]

  Special keys: enter, up, down, space, tab, escape, backspace
`)
  },
}

// Main
const [cmd = 'help', ...args] = process.argv.slice(2)

const handler = commands[cmd]
if (handler) {
  await handler(args)
} else {
  console.log(`Unknown command: ${cmd}`)
  commands.help([])
}

process.exit(0)
