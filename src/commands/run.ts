import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from './connect/client.js'
import { NULL_LOGGER } from './connect/logger.js'
import { pidAlive, readEndpoint } from './connect/endpoint-file.js'
import { bootstrapWithShimLogger, prepareConnectSink, resolveHostAndConfig } from './connect/daemon-setup.js'
import { Daemon } from './connect/daemon.js'
import type { HostConfigInput, HostProvider, HostType } from '../hosts/types.js'
import { DEFAULT_HOST_TYPE } from './connect/index.js'
import type { SandstoneContext } from 'sandstone'
import { randomUUID as nodeRandomUUID } from 'node:crypto'
import chalk from 'chalk-template'
import { parseHostConfig } from './connect/host-config.js'

export interface RunCommandOptions {
  hostType?: string,
  hostConfig?: string,
  hostConfigFile?: string,
  path: string,
  expect?: string,
  timeout?: string,
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
  // `.ts` or `.mcfunction`, compile/read it BEFORE any host work.
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
  // type + config come from the daemon.
  const endpoint = await readEndpoint(projectRoot)
  const daemonAlive = !!(endpoint && (await pidAlive(endpoint.pid)))

  // 5. Direct-mode host type resolution.
  const { hostType, userProvidedHostSettings } = resolveDirectHostType(opts)

  // 6. Daemon-mode fast path.
  if (daemonAlive && endpoint) {
    try {
      const client = await Client.open({ endpoint, logger: NULL_LOGGER })

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
  await runDirectCommands({
    hostType: directHostType,
    hostConfig,
    userProvidedHostSettings,
    commands: [command],
    expectRegex,
    timeoutMs,
    projectRoot,
  })
}

async function runDirectCommands(opts: {
  hostType: HostType,
  hostConfig: HostConfigInput,
  userProvidedHostSettings: boolean,
  commands: string[],
  expectRegex: RegExp | null,
  timeoutMs: number,
  projectRoot: string,
}): Promise<void> {
  const runSink = prepareConnectSink(opts.projectRoot, {
    headerText: 'Run',
    liveCallback: () => {},
  })
  const resolved = await resolveHostAndConfig({
    projectRoot: opts.projectRoot,
    cliHostType: undefined,
    cliHostConfig: undefined,
    cliHostConfigFile: undefined,
    sink: runSink,
  })
  const { host, spawnedByUs: weStarted } = await bootstrapWithShimLogger({
    projectRoot: opts.projectRoot,
    hostType: resolved.hostType,
    hostConfig: resolved.config,
    userProvidedHostSettings: resolved.userProvidedHostSettings,
    sink: runSink,
  })

  if (!host.capabilities.has('executeRawCommand')) {
    console.error(chalk`{red Error:} Host '${resolved.hostType}' does not support executeRawCommand`)
    await safeDisconnect(host)
    process.exit(2)
  }

  const daemon = Daemon.forDirect(host)
  try {
    const expectIdx = opts.expectRegex ? opts.commands.length - 1 : -1
    for (let i = 0; i < opts.commands.length; i++) {
      const cmd = opts.commands[i]!
      const isLast = i === expectIdx
      await runOneDirect(daemon, cmd, isLast ? opts.expectRegex : null, opts.timeoutMs)
    }
  } catch (err) {
    console.error(chalk`{red Error:} ${err instanceof Error ? err.message : String(err)}`)
    await safeDisconnect(host)
    process.exit(1)
  } finally {
    if (weStarted && host.stopServer && host.capabilities.has('stopServer')) {
      try {
        await host.stopServer()
      } catch {}
    }
    await safeDisconnect(host)
  }
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
          for (const entry of lines) {
            if (regex.test(entry.line)) {
              matched = true
              resolve(entry.line)
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

async function loadHostConfig(opts: RunCommandOptions): Promise<HostConfigInput> {
  return (await parseHostConfig(opts.hostConfig, opts.hostConfigFile)).config
}

async function safeDisconnect(host: HostProvider): Promise<void> {
  try {
    await host.disconnect()
  } catch {}
}

// TODO: Shouldn't this be replaced with one of the helpers in daemon-setup.ts
function resolveDirectHostType(opts: RunCommandOptions): {
  hostType: HostType,
  userProvidedHostSettings: boolean,
} {
  if (opts.hostType?.includes(',')) {
    console.error(
      chalk`{red Error:} Only one --host-type is supported, got '${opts.hostType}'. Composite daemons were removed.`,
    )
    process.exit(2)
  }
  const userProvidedHostSettings = !!opts.hostType || !!opts.hostConfig || !!opts.hostConfigFile
  const hostType: HostType = (opts.hostType as HostType | undefined) ?? DEFAULT_HOST_TYPE
  if (!KNOWN_HOST_TYPES.has(hostType)) {
    console.error(chalk`{red Error:} Unknown --host-type '${hostType}'`)
    process.exit(2)
  }
  if (opts.hostConfig && opts.hostConfigFile) {
    console.error(chalk`{red Error:} Pass either --host-config or --host-config-file, not both`)
    process.exit(2)
  }
  return { hostType, userProvidedHostSettings }
}

/**
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

  // `return` only makes sense inside an mcfunction.
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

  const { hostType: resolvedHostType, userProvidedHostSettings } = resolveDirectHostType(opts)

  if (daemonAlive && endpoint) {
    const client = await Client.open({ endpoint, logger: NULL_LOGGER })
    if (!client.welcome.capabilities.executeRawCommand) {
      console.error(chalk`{red Error:} Host does not support executeRawCommand`)
      client.close()
      process.exit(1)
    }
    const hasResponse = client.welcome.capabilities.executeRawCommandHasResponse
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
  await runDirectCommands({
    hostType: resolvedHostType,
    hostConfig,
    userProvidedHostSettings,
    commands,
    expectRegex,
    timeoutMs,
    projectRoot,
  })
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
  daemon: Daemon,
  command: string,
  expectRegex: RegExp | null,
  timeoutMs: number,
): Promise<void> {
  const hasResponse = daemon.host.capabilities.has('executeRawCommandHasResponse')
  const waitFor = expectRegex && !hasResponse
    ? { kind: 'regex' as const, value: expectRegex.source, timeoutMs }
    : undefined

  let result
  try {
    result = await daemon.executeRawCommand({ command, waitFor })
  } catch (err) {
    console.error(chalk`{red Error:} Command failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (result.output) console.log(result.output)

  if (!expectRegex) return

  if (hasResponse) {
    if (!expectRegex.test(result.output)) {
      console.error(chalk`{red [run]} --expect did not match command response`)
      process.exit(1)
    }
    return
  }

  // No-response host: the matcher fires once and resolves with the
  // captured lines (typically `[matching_line]`).
  if (!result.logResult) {
    console.error(chalk`{red Error:} --expect requires waitFor but no matcher was created`)
    process.exit(1)
  }
  try {
    const lines = await result.logResult
    const matched = lines[lines.length - 1]
    if (matched === undefined) {
      console.error(chalk`{red Error:} --expect timed out`)
      process.exit(1)
    }
    console.log(stripMinecraftPrefix(matched))
  } catch (err) {
    console.error(chalk`{red Error:} ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}