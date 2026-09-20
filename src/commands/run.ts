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
import { BootstrapError, bootstrapHosts } from './connect/bootstrap.js'
import type { HostConfigInput, HostProvider, HostType, LogChunkHandler } from '../hosts/types.js'
import { DEFAULT_HOST_TYPES } from './connect/index.js'
import { createSandstonePack, type SandstoneContext } from 'sandstone'
import { randomUUID as nodeRandomUUID } from 'node:crypto'
import chalk from 'chalk-template'

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
  'rcon',
  'ftp',
  'local-client',
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

  // 3. Compile --expect + resolve timeout (validity only — we may
  // decide later that --expect isn't needed).
  const expectRegex = opts.expect ? compileRegex(opts.expect) : null
  const timeoutMs = parseTimeoutMs(opts.timeout)

  // 4. Detect an alive `sand connect` daemon. When present, the host
  // type + config come from the daemon — neither flag is required.
  const endpoint = await readEndpoint(projectRoot)
  const daemonAlive = !!(endpoint && (await pidAlive(endpoint.pid)))

  // 5. Direct-mode host type resolution. Default to the same composite
  // the daemon would boot by default (rcon + integrated) so the direct
  // path matches what `sand connect` would do without a daemon.
  let hostTypes: HostType[] = opts.hostType
    ? (opts.hostType.split(',').map((s) => s.trim()).filter(Boolean) as HostType[])
    : [...DEFAULT_HOST_TYPES]
  // Forward to bootstrapHosts so it can auto-include `local-client` using
  // the same sandstone.config.ts load that injects `sandstoneConfig` per
  // host — no duplicate `import()` per invocation.
  const userProvidedHostSettings = !!opts.hostType || !!opts.hostConfig || !!opts.hostConfigFile
  if (!daemonAlive) {
    for (const t of hostTypes) {
      if (!KNOWN_HOST_TYPES.has(t)) {
        console.error(chalk`{red Error:} Unknown --host-type '${t}'`)
        process.exit(2)
      }
    }
    if (opts.hostConfig && opts.hostConfigFile) {
      console.error(chalk`{red Error:} Pass either --host-config or --host-config-file, not both`)
      process.exit(2)
    }
    // Default to a per-host-type empty config when --host-config is
    // omitted (mirrors `sand connect`). Empty `{}` per member lets
    // `getProvider` succeed; the provider's connect() picks up any
    // defaults internally.
    if (!opts.hostConfig && !opts.hostConfigFile) {
      opts.hostConfig = JSON.stringify(Object.fromEntries(hostTypes.map((t) => [t, {}])))
    }
  }
  // Downstream code uses `hostType` as a single value — pin to the
  // first type when the user supplied a comma list (the daemon path
  // already handles the full list via the endpoint file).
  const hostType: HostType = hostTypes[0]!

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

      // Ensure the server is up before issuing the command. Idempotent:
      // joins an in-flight startServer instead of crashing.
      if (client.welcome.capabilities.startServer) {
        await client.startServer().catch(() => {})
      }

      const result = await client.executeRawCommand({ command })
      if (result.output) console.log(result.output)

      if (expectRegex) {
        if (hasResponse) {
          // Match against the built-in response directly.
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
        // No built-in response: await the matching log line.
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
      // fall through to direct mode
    }
  }

  // 7. Direct mode. Use the shared bootstrap so direct mode agrees
  // with `sand connect`: same defaults (latest sandstone version,
  // RCON port/password auto-derive), same member lifecycle.
  const perHostConfig: Partial<Record<HostType, HostConfigInput>> =
    hostTypes.length === 1
      ? { [hostTypes[0]!]: await loadHostConfig(opts) }
      : (await loadHostConfig(opts)) as Partial<Record<HostType, HostConfigInput>>
  // Project root injection (the bootstrap also handles this, but we
  // need it here too so the merged config is right for logging).
  for (const t of hostTypes) {
    const cfg = perHostConfig[t] as Record<string, unknown> | undefined
    if (cfg && cfg.projectRoot === undefined) cfg.projectRoot = projectRoot
  }
  let host: HostProvider
  let weStarted: HostType[]
  try {
    const result = await bootstrapHosts({ hostTypes, perHostConfig, silent: true, userProvidedHostSettings })
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
    console.error(chalk`{red Error:} Host '${hostType}' does not support executeRawCommand`)
    await safeDisconnect(host)
    process.exit(1)
  }

  // Same gating as daemon mode.
  const hasResponse = host.capabilities.has('executeRawCommandHasResponse')
  const watcher =
    expectRegex && !hasResponse ? await attachAwaitHost(host, expectRegex, timeoutMs) : null

  // The bootstrap already started any StartServer-capable member
  // (idempotent — calling again is a no-op).

  let output: string
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
      if (!expectRegex.test(output)) {
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

  // Graceful stop before disconnect — but ONLY if we spawned the
  // server in this invocation. If the user launched integrated
  // manually (e.g. via VS Code), sending `stop` would kill their
  // session. `weStarted` is populated by `bootstrapHosts` from the
  // integrated provider's `weStartedThisCall()` flag.
  if (weStarted.length > 0 && host.stopServer && host.capabilities.has('stopServer')) {
    try {
      await host.stopServer()
    } catch {
      // ignore — disconnect cleanup still runs
    }
  }
  await safeDisconnect(host)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Strip Minecraft's log prefix from a line. The server emits
 * `[HH:MM:SS] [Thread/LEVEL]: <message>` — everything up to and
 * including the first `]: ` is server formatting, the rest is the
 * actual message. When `--expect` matches, the user wants the message,
 * not the wrapping.
 */
export const MINECRAFT_LOG_PREFIX = String.raw`^\[\d{2}:\d{2}:\d{2}\] \[[^\]]+\/\w+\]: `

const MinecraftLogPrefixRegex = new RegExp(`${MINECRAFT_LOG_PREFIX}`)

export function stripMinecraftPrefix(line: string): string {
  const m = line.match(MinecraftLogPrefixRegex)
  return m ? line.slice(m[0].length) : line
}

interface ClientLogWatcher {
  /** Resolves with the first matching line; rejects on timeout/attach error. */
  promise: Promise<string>
  /** Unattach when done (or on failure). Available only after the
   *  underlying attachLog RPC resolves — callers that need to unattach
   *  before resolving the matching line should still `await` the
   *  `subscription` promise first. */
  subscription: Promise<{ unattach(): Promise<void> }>
}

/**
 * Subscribe to a WS client's log stream and resolve on the first line
 * matching `regex`, or reject after `timeoutMs`. Attaches BEFORE
 * returning the watcher so no lines are missed between subscribe and
 * the caller sending the command.
 */
async function attachAwaitClient(
  client: Client,
  regex: RegExp,
  timeoutMs: number,
): Promise<ClientLogWatcher> {
  // Attach first so we have the subscription handle to register the
  // line listener on. The `attachLog` RPC both subscribes server-side
  // and returns an id, so the moment the promise resolves lines start
  // flowing — registering onLines immediately keeps the gap minimal.
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

/** Same pattern as {@link attachAwaitClient} but for a directly-held HostProvider. */
async function attachAwaitHost(
  host: HostProvider,
  regex: RegExp,
  timeoutMs: number,
): Promise<HostLogWatcher> {
  if (!host.attachLog) {
    throw new Error('Host does not support attachLog — cannot use --expect')
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
  if (opts.hostConfigFile) {
    const raw = await Bun.file(opts.hostConfigFile).text()
    return JSON.parse(raw)
  }
  return JSON.parse(opts.hostConfig!)
}

async function safeDisconnect(host: HostProvider): Promise<void> {
  try {
    await host.disconnect()
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// File-mode: expand a `.mcfunction` or `.ts` file into a sequence of
// console commands, then run them through the host.
// ---------------------------------------------------------------------------

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

/**
 * `import()` the user's `.ts` file, invoke its `default` export inside a
 * one-off Sandstone `MCFunction` callback, and run the default visitor
 * pipeline. The visitor output is a single compiled mcfunction string;
 * any user-created child resource (a nested `MCFunction`, an
 * `Advancement`, …) is rejected — `sand run` only supports inline
 * commands, not files-on-disk generation.
 */
async function compileTypescriptFile(filePath: string): Promise<string[]> {
  const abs = resolve(filePath)
  const fileUrl = pathToFileURL(abs).href

  // Mirror `sand build`: resolve `sandstone` from the user's file's
  // directory so the user's `import 'sandstone'` and our
  // `createSandstonePack` hit the SAME module instance. Otherwise two
  // module copies coexist (CLI's bundled + the user's resolved path)
  // and the user's `say` commands try to write into a different pack
  // singleton — "outside an MCFunction".
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

  // "What would the builder write?" — `pack.compile()` returns exactly
  // that: every file path the normal `sand build` would emit, flattened
  // to a `Map<relativePath, string>`. We snapshot the pre-compile set
  // (bootstrap entries added by SandstonePack's constructor) and diff
  // against the post-compile set. Anything left besides our root
  // mcfunction is a user-created resource — the script tried to emit a
  // file, which `sand run` can't honour.
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
 * `--expect` is applied to the LAST emitted command only — it doesn't
 * meaningfully compose with multi-command scripts.
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

  let hostTypes: HostType[] = opts.hostType
    ? (opts.hostType.split(',').map((s) => s.trim()).filter(Boolean) as HostType[])
    : [...DEFAULT_HOST_TYPES]
  // Forward to bootstrapHosts so it can auto-include `local-client` using
  // the same sandstone.config.ts load that injects `sandstoneConfig` per
  // host — no duplicate `import()` per invocation.
  const userProvidedHostSettings = !!opts.hostType || !!opts.hostConfig || !!opts.hostConfigFile
  if (!daemonAlive) {
    for (const t of hostTypes) {
      if (!KNOWN_HOST_TYPES.has(t)) {
        console.error(chalk`{red Error:} Unknown --host-type '${t}'`)
        process.exit(2)
      }
    }
    if (opts.hostConfig && opts.hostConfigFile) {
      console.error(chalk`{red Error:} Pass either --host-config or --host-config-file, not both`)
      process.exit(2)
    }
    if (!opts.hostConfig && !opts.hostConfigFile) {
      opts.hostConfig = JSON.stringify(Object.fromEntries(hostTypes.map((t) => [t, {}])))
    }
  }
  const hostType: HostType = hostTypes[0]!

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
  const perHostConfig: Partial<Record<HostType, HostConfigInput>> =
    hostTypes.length === 1
      ? { [hostTypes[0]!]: await loadHostConfig(opts) }
      : ((await loadHostConfig(opts)) as Partial<Record<HostType, HostConfigInput>>)
  for (const t of hostTypes) {
    const cfg = perHostConfig[t] as Record<string, unknown> | undefined
    if (cfg && cfg.projectRoot === undefined) cfg.projectRoot = projectRoot
  }
  let host: HostProvider
  let weStarted: HostType[]
  try {
    const result = await bootstrapHosts({ hostTypes, perHostConfig, silent: true, userProvidedHostSettings })
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
    console.error(chalk`{red Error:} Host '${hostType}' does not support executeRawCommand`)
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
    if (weStarted.length > 0 && host.stopServer && host.capabilities.has('stopServer')) {
      try {
        await host.stopServer()
      } catch {
        // ignore
      }
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
  let output: string
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
    if (!expectRegex.test(output)) {
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