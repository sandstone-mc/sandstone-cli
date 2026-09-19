/**
 * `sand run` — run a Minecraft console command on the configured server.
 *
 * Two modes:
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
 */

import { resolve } from 'node:path'
import { connect as openClient, type Client } from '../connect/client.js'
import { pidAlive, readEndpoint } from '../connect/endpoint-file.js'
import { BootstrapError, bootstrapHosts } from '../connect/bootstrap.js'
import type { HostConfigInput, HostProvider, HostType, LogChunkHandler } from '../hosts/types.js'
import { DEFAULT_HOST_TYPES } from './connect.js'
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

  // 2. Compile --expect + resolve timeout (validity only — we may
  // decide later that --expect isn't needed).
  const expectRegex = opts.expect ? compileRegex(opts.expect) : null
  const timeoutMs = parseTimeoutMs(opts.timeout)

  // 3. Detect an alive `sand connect` daemon. When present, the host
  // type + config come from the daemon — neither flag is required.
  const endpoint = await readEndpoint(projectRoot)
  const daemonAlive = !!(endpoint && (await pidAlive(endpoint.pid)))

  // 4. Direct-mode host type resolution. Default to the same composite
  // the daemon would boot by default (rcon + integrated) so the direct
  // path matches what `sand connect` would do without a daemon.
  let hostTypes: HostType[] = opts.hostType
    ? (opts.hostType.split(',').map((s) => s.trim()).filter(Boolean) as HostType[])
    : [...DEFAULT_HOST_TYPES]
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

  // 5. Daemon-mode fast path.
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
          await client.unattach({ subscriptionId: watcher!.subscriptionId }).catch(() => {})
          client.close()
          return
        } catch (err) {
          await client.unattach({ subscriptionId: watcher!.subscriptionId }).catch(() => {})
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

  // 5. Direct mode. Use the shared bootstrap so direct mode agrees
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
    const result = await bootstrapHosts({ hostTypes, perHostConfig, silent: true })
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

function stripMinecraftPrefix(line: string): string {
  const m = line.match(MinecraftLogPrefixRegex)
  return m ? line.slice(m[0].length) : line
}

interface ClientLogWatcher {
  /** Resolves with the first matching line; rejects on timeout/attach error. */
  promise: Promise<string>
  subscriptionId: string
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
  // Subscribe first so we don't miss lines, THEN attach (which tells
  // the server to start streaming).
  let matched = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const promise = new Promise<string>((resolve, reject) => {
    client.onLog((_id, lines) => {
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
  })
  promise.finally(() => {
    if (timer) clearTimeout(timer)
  })

  const { subscriptionId } = await client.attachLog({ regex: regex.source })
  return { promise, subscriptionId }
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