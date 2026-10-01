/**
 * `sand run` — run a Minecraft console command on the configured server.
 *
 * Two invocation shapes:
 *  - **Raw command** (default): the joined `<command...>` args are sent
 *    to the server as a single console command.
 *  - **File path** (when the joined args end in `.ts` or `.mcfunction`):
 *    the file is read and expanded into a sequence of console commands:
 *      - `.mcfunction` — every non-empty, non-comment (`#`) line is sent
 *        in order, after `.trim()`.
 *      - `.ts` — the file is `import()`-ed as ESM; its `default` export
 *        must be a function. The function runs inside a one-off Sandstone
 *        MCFunction callback; Sandstone's default visitor pipeline
 *        compiles the body into mcfunction text. If the script created
 *        ANY extra user-level resources (a child `MCFunction`, an
 *        `Advancement`, a `Recipe`, …), `sand run` throws — only inline
 *        commands are supported.
 *
 * Two connection modes:
 *  - **Daemon mode** (preferred when a `sand connect` daemon is alive for
 *    the project): read `<projectRoot>/.sandstone/connect.url`, dial the
 *    WS, send `executeRawCommand`, exit. The host stays connected so the
 *    user can run more commands quickly.
 *  - **Direct mode** (no daemon): instantiate the host from
 *    `--host-config`, `connect()`, send the command, `disconnect()`. One
 *    round-trip per invocation; no state preserved.
 *
 * `--expect <pattern>`: match the regex against the command's
 * acknowledgement to decide the exit code.
 *  - Built-in response available (rcon, mcsmanager-login): match the
 *    regex against the returned string. Match → exit 0, no match →
 *    exit 1.
 *  - No built-in response (integrated writes to child stdin): attach to
 *    the log BEFORE sending the command and wait up to `--timeout`
 *    seconds (default 30) for a matching line. Match → exit 0, timeout
 *    → exit 1.
 *  - File mode applies `--expect` to the LAST emitted command only.
 */

import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect as openClient, type Client } from './connect/client.js'
import { pidAlive, readEndpoint } from './connect/endpoint-file.js'
import { BootstrapError, bootstrapHost } from './connect/bootstrap.js'
import type { HostConfigInput, HostProvider, HostType, LogChunkHandler } from '../hosts/types.js'
import { DEFAULT_HOST_TYPE } from './connect/index.js'
import type { SandstoneContext } from 'sandstone'
import { randomUUID as nodeRandomUUID } from 'node:crypto'
import chalk from 'chalk-template'
import { parseHostConfig } from './connect/host-config.js'

export interface RunCommandOptions {
  /** `--host-type <type>` — required (same set as `sand connect`). */
  hostType?: string
  /** `--host-config <json>` */
  hostConfig?: string
  /** `--host-config-file <path>` */
  hostConfigFile?: string
  /** `--path <path>` (project root). */
  path: string
  /** `--expect <pattern>` — wait for this regex against subsequent log lines. */
  expect?: string
  /** `--timeout <seconds>` — wait up to this many seconds for `--expect` (default 30). */
  timeout?: string
}

const DEFAULT_TIMEOUT_SECONDS = 30

const KNOWN_HOST_TYPES = new Set<HostType>([
  'ssh',
  'ftp',
  'integrated',
  'mcsmanager-login',
])

export async function runCommand(
  opts: RunCommandOptions,
  commandAndArgs: string[],
): Promise<void> {
  const projectRoot = resolve(opts.path)

  // 1. Reconstruct the command line.
  const command = (Array.isArray(commandAndArgs) ? commandAndArgs : [commandAndArgs]).filter(Boolean).join(' ')
  if (!command) {
    console.error(chalk`{red Error:} Missing command`)
    process.exit(2)
  }

  // 2. File-mode dispatch FIRST. When the joined argument ends in
  // `.ts` or `.mcfunction`, compile/read it BEFORE any host work — a
  // bad script should fail before we waste time on `readEndpoint` or
  // `bootstrapHosts`.
  if (command.endsWith('.mcfunction') || command.endsWith('.ts')) {
    const commands = command.endsWith('.mcfunction')
      ? await readMcfunctionFile(command)
      : await compileTypescriptFile(command)
    if (commands.length === 0) return
    const expectRegex = opts.expect ? compileRegex(opts.expect) : null
    const timeoutMs = parseTimeoutMs(opts.timeout)
    await runCommands(opts, commands, expectRegex, timeoutMs, projectRoot)
    return
  }

  // 3. Compile --expect + resolve timeout.
  const expectRegex = opts.expect ? compileRegex(opts.expect) : null
  const timeoutMs = parseTimeoutMs(opts.timeout)

  // 4. Detect an alive `sand connect` daemon. When present, the host
  // type + config come from the daemon — neither flag is required.
  const endpoint = await readEndpoint(projectRoot)
  const daemonAlive = !!(endpoint && (await pidAlive(endpoint.pid)))

  // 5. Direct-mode host type resolution.
  let hostType: HostType | undefined
  if (opts.hostType) {
    hostType = opts.hostType as HostType
  }
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
  }
  const userProvidedHostSettings = !!opts.hostType || !!opts.hostConfig || !!opts.hostConfigFile

  // 6. Daemon-mode fast path.
  if (daemonAlive && endpoint) {
    try {
      const client = await openClient({ endpoint })

      if (!client.welcome.capabilities.executeRawCommand) {
        console.error(chalk`{red Error:} Host does not support executeRawCommand`)
        client.close()
        process.exit(1)
      }

      const hasResponse = client.welcome.capabilities.executeRawCommandHasResponse
      // Attach before sending only when we need to fall back to the log.
      const watcher =
        expectRegex && !hasResponse
          ? await attachAwaitClient(client, expectRegex, timeoutMs)
          : null

      if (client.welcome.capabilities.startServer) {
        await client.startServer().catch(() => {})
      }

      const result = await client.executeRawCommand({ command })
      if (result.output) console.log(result.output)

      if (expectRegex) {
        if (hasResponse) {
          if (!expectRegex.test(result.output)) {
            client.close()
            console.error(
              chalk`{red [run]} --expect did not match command response`,
            )
            process.exit(1)
          }
          client.close()
          return
        }
        try {
          const line = await watcher!.promise
          console.log(stripMinecraftPrefix(line))
          await (await watcher!.subscription).unattach().catch(() => {})
          client.close()
          return
        } catch (err) {
          await (await watcher!.subscription).unattach().catch(() => {})
          client.close()
          console.error(chalk`{red Error:} ${err instanceof Error ? err.message : String(err)}`)
          process.exit(1)
        }
      }

      client.close()
      return
    } catch (err) {
      console.error(
        chalk`{yellow [run]} daemon unreachable (${err instanceof Error ? err.message : String(err)}); falling back to direct connect`,
      )
    }
  }

  // 7. Direct mode. Use the shared bootstrap so direct mode agrees
  // with `sand connect`: same defaults (latest sandstone version,
  // RCON port/password auto-derive), same member lifecycle.
  const directHostType = hostType ?? DEFAULT_HOST_TYPE
  const hostConfig = await loadHostConfig(opts)
  if (hostConfig.projectRoot === undefined) hostConfig.projectRoot = projectRoot
  let host: HostProvider
  let weStarted = false
  try {
    const result = await bootstrapHost({
      hostType: directHostType,
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
    process.exit(1)
  }

  if (!host.capabilities.has('executeRawCommand')) {
    console.error(chalk`{red Error:} Host '${directHostType}' does not support executeRawCommand`)
    await safeDisconnect(host)
    process.exit(1)
  }

  const hasResponse = host.capabilities.has('executeRawCommandHasResponse')
  const watcher = expectRegex && !hasResponse ? await attachAwaitHost(host, expectRegex, timeoutMs) : null

  let output: string | undefined
  try {
    output = await host.executeRawCommand!(command)
  } catch (err) {
    if (watcher) await watcher.cleanup().catch(() => {})
    console.error(chalk`{red Error:} Command failed: ${err instanceof Error ? err.message : String(err)}`)
    await safeDisconnect(host)
    process.exit(1)
  }
  if (output) console.log(output)

  if (expectRegex) {
    if (hasResponse) {
      if (!expectRegex.test(output!)) {
        console.error(chalk`{red [run]} --expect did not match command response`)
        await safeDisconnect(host)
        process.exit(1)
      }
      await safeDisconnect(host)
      return
    }
    try {
      const line = await watcher!.promise
      console.log(stripMinecraftPrefix(line))
      await watcher!.cleanup()
    } catch (err) {
      await watcher!.cleanup().catch(() => {})
      console.error(chalk`{red Error:} ${err instanceof Error ? err.message : String(err)}`)
      await safeDisconnect(host)
      process.exit(1)
    }
  }

  if (weStarted && host.stopServer && host.capabilities.has('stopServer')) {
    try {
      await host.stopServer()
    } catch {}
  }
  await safeDisconnect(host)
}

function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'm')
  } catch (err) {
    console.error(chalk`{red Error:} Invalid --expect regex: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
}

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_SECONDS * 1000
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(chalk`{red Error:} --timeout must be a positive number of seconds`)
    process.exit(2)
  }
  return n * 1000
}

export const MINECRAFT_LOG_PREFIX = String.raw`^\[\d{2}:\d{2}:\d{2}\] \[[^\]]+\/\w+\]: `

const MinecraftLogPrefixRegex = new RegExp(`${MINECRAFT_LOG_PREFIX}`)

export function stripMinecraftPrefix(line: string): string {
  const m = line.match(MinecraftLogPrefixRegex)
  return m ? line.slice(m[0].length) : line
}

interface ClientLogWatcher {
  promise: Promise<string>
  subscription: Promise<{ unattach(): Promise<void> }>
}

async function attachAwaitClient(
  client: Client,
  regex: RegExp,
  timeoutMs: number,
): Promise<ClientLogWatcher> {
  const subscriptionPromise = client.attachLog({ regex: regex.source })

  let matched = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const promise = subscriptionPromise.then(
    (sub) =>
      new Promise<string>((resolve, reject) => {
        sub.onLines((lines) => {
          if (matched) return
          for (const line of lines) {
            if (regex.test(line)) {
              matched = true
              resolve(line)
              return
            }
          }
        })
        timer = setTimeout(() => {
          if (!matched) reject(new Error(`--expect timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }),
  )
  promise.finally(() => {
    if (timer) clearTimeout(timer)
  })
  return { promise, subscription: subscriptionPromise }
}

interface HostLogWatcher {
  promise: Promise<string>
  cleanup(): Promise<void>
}

async function attachAwaitHost(
  host: HostProvider,
  regex: RegExp,
  timeoutMs: number,
): Promise<HostLogWatcher> {
  if (!host.attachLog) {
    throw new Error('Host does not support attachLog; cannot use --expect')
  }
  let matched = false
  let subscription: { unattach: () => Promise<void> } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const promise = new Promise<string>((resolve, reject) => {
    const handler: LogChunkHandler = (lines) => {
      if (matched) return
      for (const line of lines) {
        if (regex.test(line)) {
          matched = true
          resolve(line)
          return
        }
      }
    }
    host
      .attachLog!(handler)
      .then((sub) => {
        subscription = sub
        if (matched) sub.unattach().catch(() => {})
      })
      .catch((err) => reject(err instanceof Error ? err : new Error(String(err))))
    timer = setTimeout(() => {
      if (!matched) reject(new Error(`--expect timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
  })
  promise.finally(() => {
    if (timer) clearTimeout(timer)
  })
  return {
    promise,
    async cleanup() {
      if (subscription) await subscription.unattach().catch(() => {})
    },
  }
}

async function loadHostConfig(opts: RunCommandOptions): Promise<HostConfigInput> {
  return (await parseHostConfig(opts.hostConfig, opts.hostConfigFile)).config
}

async function safeDisconnect(host: HostProvider): Promise<void> {
  try {
    await host.disconnect()
  } catch {}
}

/**
 * Trim, drop blanks, drop `#`-prefixed comments. Mirrors Minecraft's
 * own mcfunction loader so the on-disk file and the wire command are
 * interchangeable.
 *
 * A trailing `\` is a line continuation: drop the `\` and append the
 * following line. Chains collapse (a `\`-terminated line joins the
 * next, which itself may continue).
 */
export function parseMcfunctionLines(text: string): string[] {
  const raw = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
  const joined: string[] = []
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i]!
    while (line.endsWith('\\') && i + 1 < raw.length) {
      line = line.slice(0, -1) + raw[i + 1]
      i++
    }
    joined.push(line)
  }
  return joined
}

async function readMcfunctionFile(filePath: string): Promise<string[]> {
  const abs = resolve(filePath)
  let text: string
  try {
    text = await Bun.file(abs).text()
  } catch (err) {
    console.error(
      chalk`{red Error:} Cannot read {cyan ${abs}}: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(2)
  }
  return parseMcfunctionLines(text)
}

async function compileTypescriptFile(filePath: string): Promise<string[]> {
  const abs = resolve(filePath)
  const fileUrl = pathToFileURL(abs).href

  const userDirUrl = pathToFileURL(dirname(abs)).href
  let sandstonePath: string
  try {
    sandstonePath = Bun.resolveSync('sandstone', userDirUrl)
  } catch (err) {
    console.error(
      chalk`{red Error:} Cannot resolve {cyan sandstone} from {cyan ${dirname(abs)}}: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(2)
  }
  const sandstone = (await import(pathToFileURL(sandstonePath).href)) as typeof import('sandstone')

  let mod: Record<string, unknown>
  try {
    mod = (await import(fileUrl)) as Record<string, unknown>
  } catch (err) {
    console.error(
      chalk`{red Error:} Cannot import {cyan ${abs}}: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(2)
  }
  const fn = mod.default
  if (typeof fn !== 'function') {
    console.error(
      chalk`{red Error:} {cyan ${abs}} must {bold export default function} that uses Sandstone commands`,
    )
    process.exit(2)
  }

  const ROOT = '__sand_run_main__'
  const context: SandstoneContext = {
    workingDir: dirname(abs),
    namespace: 'sand_run',
    packUid: nodeRandomUUID(),
    packOptions: {
      datapack: { packFormat: 112, description: 'sand run scratch' },
    },
  }
  const pack = sandstone.createSandstonePack(context)

  const bootstrapKeys = new Set<string>()
  for (const wrapper of pack.core.resourceNodes) {
    const r = wrapper.resource as {
      packType?: { type: string; resourceSubFolder?: string }
      path?: string[]
      fileExtension?: string
    }
    if (!r.packType || !r.path) continue
    const sub = r.packType.resourceSubFolder
    const parts = sub ? [r.packType.type, sub, ...r.path] : [r.packType.type, ...r.path]
    bootstrapKeys.add(`${parts.join('/')}.${r.fileExtension ?? ''}`)
  }

  let resources: Map<string, string>
  try {
    resources = pack.compile(ROOT, fn as () => void)
  } catch (err) {
    console.error(
      chalk`{red Error:} {cyan ${abs}} threw during compilation: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }

  const rootKey = `datapack/data/${context.namespace}/function/${ROOT}.mcfunction`
  const extras: string[] = []
  let rootBody = ''
  for (const [path, value] of resources) {
    if (path === rootKey) {
      rootBody = value
      continue
    }
    if (bootstrapKeys.has(path)) continue
    extras.push(path)
  }
  if (extras.length > 0) {
    console.error(
      chalk`{red Error:} {cyan ${abs}} created child resource(s): {bold ${extras.join(', ')}}. {bold sand run} only supports inline commands; remove nested MCFunction / Advancement / Recipe / etc. declarations.`,
    )
    process.exit(1)
  }
  if (!rootBody) {
    console.error(
      chalk`{red Error:} {cyan ${abs}} did not produce any commands`,
    )
    process.exit(1)
  }
  return parseMcfunctionLines(rootBody)
}

/**
 * Run every command in `commands` through the host, reusing a single
 * connection for the whole batch. Mirrors the daemon/direct-mode branch
 * structure of {@link runCommand} but loops over the command list.
 *
 * `--expect` is applied to the LAST emitted command only.
 */
async function runCommands(
  opts: RunCommandOptions,
  commands: string[],
  expectRegex: RegExp | null,
  timeoutMs: number,
  projectRoot: string,
): Promise<void> {
  const expectIdx = expectRegex ? commands.length - 1 : -1

  // Minecraft's `return` only makes sense inside an mcfunction or as
  // an `execute … run return` subcommand — sending it standalone via
  // RCON is almost always a mistake. Reject both forms up-front.
  const badReturn = commands.find((c) => c.startsWith('return ') || c.includes(' run return '))
  if (badReturn !== undefined) {
    console.error(
      chalk`{red Error:} {bold "${badReturn}"} uses Minecraft's {bold return} command, which only works inside an mcfunction. Remove it from your script.`,
    )
    process.exit(2)
  }

  // Host-type resolution (same rules as runCommand).
  const endpoint = await readEndpoint(projectRoot)
  const daemonAlive = !!(endpoint && (await pidAlive(endpoint.pid)))

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
    const client = await openClient({ endpoint })
    if (!client.welcome.capabilities.executeRawCommand) {
      console.error(chalk`{red Error:} Host does not support executeRawCommand`)
      client.close()
      process.exit(1)
    }
    const hasResponse = client.welcome.capabilities.executeRawCommandHasResponse
    if (client.welcome.capabilities.startServer) {
      await client.startServer().catch(() => {})
    }
    try {
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]!
        const isLast = i === expectIdx
        await runOneDaemon(client, cmd, isLast ? expectRegex : null, timeoutMs, hasResponse)
      }
    } finally {
      client.close()
    }
    return
  }

  // Direct mode.
  const hostConfig = await loadHostConfig(opts)
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
    process.exit(1)
  }
  if (!host.capabilities.has('executeRawCommand')) {
    console.error(chalk`{red Error:} Host '${resolvedHostType}' does not support executeRawCommand`)
    await safeDisconnect(host)
    process.exit(1)
  }

  try {
    const hasResponse = host.capabilities.has('executeRawCommandHasResponse')
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!
      const isLast = i === expectIdx
      await runOneDirect(host, cmd, isLast ? expectRegex : null, timeoutMs, hasResponse)
    }
  } finally {
    if (weStarted && host.stopServer && host.capabilities.has('stopServer')) {
      try {
        await host.stopServer()
      } catch {}
    }
    await safeDisconnect(host)
  }
}

async function runOneDaemon(
  client: Client,
  command: string,
  expectRegex: RegExp | null,
  timeoutMs: number,
  hasResponse: boolean,
): Promise<void> {
  const watcher =
    expectRegex && !hasResponse ? await attachAwaitClient(client, expectRegex, timeoutMs) : null
  try {
    const result = await client.executeRawCommand({ command })
    if (result.output) console.log(result.output)
    if (!expectRegex) return
    if (hasResponse) {
      if (!expectRegex.test(result.output)) {
        console.error(chalk`{red [run]} --expect did not match command response`)
        process.exit(1)
      }
      return
    }
    try {
      const line = await watcher!.promise
      console.log(stripMinecraftPrefix(line))
      await (await watcher!.subscription).unattach().catch(() => {})
    } catch (err) {
      await (await watcher!.subscription).unattach().catch(() => {})
      console.error(chalk`{red Error:} ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  } catch (err) {
    if (watcher) await (await watcher.subscription).unattach().catch(() => {})
    console.error(chalk`{red Error:} Command failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

async function runOneDirect(
  host: HostProvider,
  command: string,
  expectRegex: RegExp | null,
  timeoutMs: number,
  hasResponse: boolean,
): Promise<void> {
  const watcher =
    expectRegex && !hasResponse ? await attachAwaitHost(host, expectRegex, timeoutMs) : null
  let output: string | undefined
  try {
    output = await host.executeRawCommand!(command)
  } catch (err) {
    if (watcher) await watcher.cleanup().catch(() => {})
    console.error(chalk`{red Error:} Command failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  if (output) console.log(output)
  if (!expectRegex) {
    if (watcher) await watcher.cleanup().catch(() => {})
    return
  }
  if (hasResponse) {
    if (watcher) await watcher.cleanup().catch(() => {})
    if (!expectRegex.test(output!)) {
      console.error(chalk`{red [run]} --expect did not match command response`)
      process.exit(1)
    }
    return
  }
  try {
    const line = await watcher!.promise
    console.log(stripMinecraftPrefix(line))
    await watcher!.cleanup()
  } catch (err) {
    await watcher!.cleanup().catch(() => {})
    console.error(chalk`{red Error:} ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}