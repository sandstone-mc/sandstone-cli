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
 * `executeRawCommand` returns whatever the provider's command channel
 * surfaces. For most providers that's the response lines; for
 * `integrated` it returns `''` (the JVM doesn't echo console commands
 * reliably — use `sand connect` + `attachLog` to observe output).
 */

import { resolve } from 'node:path'
import { connect as openClient } from '../connect/client.js'
import { pidAlive, readEndpoint } from '../connect/endpoint-file.js'
import { getProvider } from '../hosts/registry.js'
import type { HostProvider, HostType } from '../hosts/types.js'
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
}

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

  // 1. Validate host-type + config up front (needed in both modes).
  const hostType = opts.hostType as HostType | undefined
  if (!hostType) {
    console.error(chalk`{red Error:} --host-type is required (one of: ssh, rcon, ftp, local-client, integrated, mcsmanager-login)`)
    process.exit(2)
  }
  if (!KNOWN_HOST_TYPES.has(hostType)) {
    console.error(chalk`{red Error:} Unknown --host-type '${hostType}'`)
    process.exit(2)
  }
  if (!opts.hostConfig && !opts.hostConfigFile) {
    console.error(chalk`{red Error:} Either --host-config <json> or --host-config-file <path> is required`)
    process.exit(2)
  }
  if (opts.hostConfig && opts.hostConfigFile) {
    console.error(chalk`{red Error:} Pass either --host-config or --host-config-file, not both`)
    process.exit(2)
  }

  // 2. Reconstruct the command line. Commander's rest-positional args
  // land in the second handler arg (see index.ts); we accept the joined
  // string OR an array.
  const command = (Array.isArray(commandAndArgs) ? commandAndArgs : [commandAndArgs]).filter(Boolean).join(' ')
  if (!command) {
    console.error(chalk`{red Error:} Missing command`)
    process.exit(2)
  }

  // 3. Daemon-mode fast path: read endpoint + send via WS.
  const endpoint = await readEndpoint(projectRoot)
  if (endpoint && (await pidAlive(endpoint.pid))) {
    try {
      const client = await openClient({ endpoint })
      const result = await client.executeRawCommand({ command })
      if (result.output) console.log(result.output)
      client.close()
      return
    } catch (err) {
      console.error(
        chalk`{yellow [run]} daemon unreachable (${err instanceof Error ? err.message : String(err)}); falling back to direct connect`,
      )
      // fall through to direct mode
    }
  }

  // 4. Direct mode: instantiate + connect + run + disconnect.
  const factory = getProvider(hostType)
  if (!factory) {
    console.error(chalk`{red Error:} No provider registered for '${hostType}'`)
    process.exit(1)
  }

  let hostConfig = await loadHostConfig(opts)
  if (typeof (hostConfig as { projectRoot?: unknown }).projectRoot !== 'string') {
    ;(hostConfig as Record<string, unknown>).projectRoot = projectRoot
  }

  let host: HostProvider
  try {
    host = factory.create(hostConfig)
    await host.connect()
  } catch (err) {
    console.error(chalk`{red Error:} Failed to connect '${hostType}': ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  if (!host.capabilities.executeRawCommand) {
    console.error(chalk`{red Error:} Host '${hostType}' does not support executeRawCommand`)
    await safeDisconnect(host)
    process.exit(1)
  }

  try {
    const output = await host.executeRawCommand!(command)
    if (output) console.log(output)
  } catch (err) {
    console.error(chalk`{red Error:} Command failed: ${err instanceof Error ? err.message : String(err)}`)
    await safeDisconnect(host)
    process.exit(1)
  }

  await safeDisconnect(host)
}

async function loadHostConfig(opts: RunCommandOptions): Promise<unknown> {
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