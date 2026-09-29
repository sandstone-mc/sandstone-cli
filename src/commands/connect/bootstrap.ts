/**
 * Shared host-bootstrap path used by both `sand connect` (long-lived
 * daemon) and `sand run` (one-shot direct invocation). Encapsulates:
 *  1. Per-type defaulting (latest sandstone version, RCON port/password
 *     auto-derived when integrated is chosen).
 *  2. Two-phase member connection (StartServer-capable first, then the
 *     rest) so members that connect over the wire only join after
 *     their target server is up.
 *  3. Sequential `startServer()` calls for each StartServer-capable
 *     member — each must complete before the next so downstream
 *     members can connect to a running server.
 *
 * Returns the connected host + the (possibly mutated) per-type config
 * so callers can re-emit it for display.
 */

import { randomBytes } from 'node:crypto'
import path from 'path'
import chalk from 'chalk-template'

import { getAvailableSandstoneVersions } from '../versionDiscovery.js'
import { getProvider } from '../../hosts/registry.js'
import '../../hosts/index.js' // side-effect: register all providers
// CompositeHost was removed — single-host daemons only.
import * as fs from '../../utils/fs.js'
import { loadSandstoneConfig } from '../../utils/sandstoneConfig.js'
import type { SandstoneConfig } from 'sandstone'
import type { HostConfigInput, HostProvider, HostType } from '../../hosts/types.js'

/**
 * Pure helper: pull `clientPath` out of an already-loaded
 * `SandstoneConfig` for the `local-client` host's default config.
 * Returns `null` when the config has no usable `saveOptions.clientPath`.
 *
 * Used by {@link bootstrapHosts} after it loads the project's
 * `sandstone.config.ts` for `sandstoneConfig` injection — re-using the
 * same load avoids a duplicate `import()` per invocation.
 */
export function localClientConfigFromSandstoneConfig(
  cfg: SandstoneConfig | undefined,
): HostConfigInput | null {
  const clientPath = cfg?.saveOptions?.clientPath
  if (typeof clientPath !== 'string' || clientPath.length === 0) return null
  return { clientPath } as HostConfigInput
}

export interface BootstrapOptions {
  hostType: HostType
  perHostConfig: Partial<Record<HostType, HostConfigInput>>
  /**
   * When true, the caller passed explicit `--host-type` / `--host-config` /
   * `--host-config-file`. Suppresses the auto-`local-client` augmentation
   * (explicit settings always win — the user may have intentionally
   * omitted `local-client`).
   */
  userProvidedHostSettings?: boolean
  /** When true, suppress the `[bootstrap]` informational logs (one-shot
   *  invocations like `sand run` shouldn't announce every default it
   *  derived). Errors and warnings still print. */
  silent?: boolean
}

export interface BootstrapResult {
  host: HostProvider
  /** Member list in instantiation order (preserves user-specified order). */
  members: HostProvider[]
  perHostConfig: Partial<Record<HostType, HostConfigInput>>
  /** Members that successfully connect.startServer()'d before this returned. */
  startedMembers: HostType[]
  /**
   * Members the bootstrap ACTUALLY spawned (vs. finding already-up). Set
   * via `IntegratedHost.weStartedThisCall()` — only meaningful for the
   * integrated provider. Lets `sand run` decide whether `stopServer` is
   * safe on exit (don't kill a server the user started manually).
   */
  spawnedByUs: HostType[]
}

export class BootstrapError extends Error {
  constructor(message: string, public readonly code: 'no-factory' | 'host-failed' | 'start-failed') {
    super(message)
    this.name = 'BootstrapError'
  }
}

/**
 * Resolve default config + instantiate + connect + start + wrap. Used
 * by both `sand connect` (which then runs the WS server) and `sand run`
 * (which then issues the command).
 */
export async function bootstrapHosts(opts: BootstrapOptions): Promise<BootstrapResult> {
  const hostType = opts.hostType
  const perHostConfig = await resolveDefaults([hostType], opts.perHostConfig, opts.silent ?? false)

  // Auto-load the project's sandstone.config.ts (if any) and thread it
  // through to the host so providers that care about the pack name,
  // save options, etc. don't have to re-import the file themselves.
  const autocfg = await loadSandstoneConfig(process.cwd())
  if (autocfg) {
    const existing = perHostConfig[hostType]
    if (existing && !('sandstoneConfig' in existing)) {
      perHostConfig[hostType] = { ...existing, sandstoneConfig: autocfg }
    }
  }

  // Auto-include `local-client` when the user passed no host settings and
  // saveOptions.clientPath is set in the just-loaded config. Re-uses the
  // load above so we don't `import()` the config twice per invocation.
  // The `userProvidedHostSettings` flag is the gate; explicit host flags
  // always win, even if they happen to mention `local-client`.
  // NOTE: must mutate the LOCAL `hostTypes` / `perHostConfig` (resolved
  // copies), not `opts.*` — `resolveDefaults` deep-copies the caller's
  // perHostConfig and the local instance loop reads from `perHostConfig`,
  // so writing to `opts.perHostConfig` would leave the new member with
  // undefined config and the LocalClientHost would throw on attachLog.
  if (!opts.userProvidedHostSettings) {
    const localClientCfg = localClientConfigFromSandstoneConfig(autocfg ?? undefined)
    if (localClientCfg) {
      // Auto-include local-client as a *second* host. Bootstrap
      // returns just the primary host; local-client is bootstrapped
      // separately for log attach. Single-host is the rule; the
      // exception is local-client, which rides alongside for log
      // streaming only.
      const existing = perHostConfig['local-client']
      perHostConfig['local-client'] = {
        ...(existing ?? {}),
        ...localClientCfg,
      }
    }
  }

  // Instantiate the single requested provider. Multi-host daemons are
  // gone — `--host-type` accepts exactly one host type.
  const factory = getProvider(hostType)
  if (!factory) {
    throw new BootstrapError(`Unknown host type: ${hostType}`, 'no-factory')
  }
  const memberConfig = perHostConfig[hostType]
  let member: HostProvider
  try {
    member = factory.create(memberConfig)
  } catch (e) {
    throw new BootstrapError(
      `Failed to construct host '${hostType}': ${e instanceof Error ? e.message : String(e)}`,
      'host-failed',
    )
  }

  // Two-phase connect: StartServer-capable first (their `connect()`
  // doesn't require a running server), then the rest.
  const hasStartServer = member.capabilities.has('startServer')

  try {
    await member.connect()
  } catch (e) {
    throw new BootstrapError(
      `Failed to connect host '${hostType}': ${e instanceof Error ? e.message : String(e)}`,
      'host-failed',
    )
  }

  const started: HostType[] = []
  const spawnedByUs: HostType[] = []
  if (hasStartServer && member.startServer) {
    try {
      await member.startServer()
      started.push(hostType)
      const maybeIntegrated = member as { weStartedThisCall?: () => boolean }
      if (maybeIntegrated.weStartedThisCall?.()) {
        spawnedByUs.push(hostType)
      }
    } catch (e) {
      throw new BootstrapError(
        `Failed to start server on '${hostType}': ${e instanceof Error ? e.message : String(e)}`,
        'start-failed',
      )
    }
  }

  // Single host. CompositeHost was removed — there's no fan-out
  // dispatch and no attachLogs surface anymore. Each provider owns
  // its console (RCON for integrated, WS for mcsmanager).
  return { host: member, members: [member], perHostConfig, startedMembers: started, spawnedByUs }
}

/**
 * Per-type defaults for the integrated+rcon scenario:
 *  - `integrated.sandstoneVersion` ← latest from `getAvailableSandstoneVersions()`
 *  - `integrated.rcon.{enabled,port,password}` ← mirrored from rcon provider config
 *  - `rcon.port` ← scan 127.0.0.1 starting at 25575 if missing/0
 *  - `rcon.password` ← random 32-hex if missing
 *  - `rcon.host` ← `integrated.host` (forward-compat) or `127.0.0.1`
 *
 * User-supplied values always win over auto-derived defaults.
 */
async function resolveDefaults(
  hostTypes: HostType[],
  input: Partial<Record<HostType, HostConfigInput>>,
  silent: boolean,
): Promise<Partial<Record<HostType, HostConfigInput>>> {
  const out: Partial<Record<HostType, HostConfigInput>> = JSON.parse(JSON.stringify(input))
  const log = silent ? () => {} : console.log

  // Default integrated.sandstoneVersion to the latest minor.
  const has = (t: HostType) => hostTypes.includes(t)
  if (has('integrated')) {
    const integratedCfg = (out.integrated ?? {}) as Record<string, unknown>
    if (typeof integratedCfg.sandstoneVersion !== 'string') {
      // Prefer the version actually installed in the project's
      // node_modules — the user has already committed to one, defaulting
      // to npm-latest would silently drift the server MC version. Only
      // fall through to a network fetch when there's no installed copy.
      let resolved = false
      try {
        const pkg = await fs.readJSON<{ version?: string }>(
          path.join(process.cwd(), 'node_modules', 'sandstone', 'package.json'),
        )
        if (pkg.version) {
          integratedCfg.sandstoneVersion = pkg.version
          log(chalk`{cyan [bootstrap]} sandstoneVersion not set -- using installed ${pkg.version}`)
          resolved = true
        }
      } catch { /* not installed locally — fall through to latest */ }

      if (!resolved) {
        try {
          const versions = await getAvailableSandstoneVersions()
          const top = versions[0]
          if (top) {
            const tag = `${top.major}.${top.minor}.0`
            integratedCfg.sandstoneVersion = tag
            log(chalk`{cyan [bootstrap]} sandstoneVersion not set -- using latest ${tag}`)
          }
        } catch (err) {
          // Surface network errors even in silent mode — they affect
          // correctness, not just chat.
          console.error(
            `[bootstrap] could not fetch latest sandstone version: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      out.integrated = integratedCfg as HostConfigInput
    }
  }

  // Auto-configure the integrated host's rcon block whenever integrated
  // is selected. RCON is mandatory for integrated — the host refuses to
  // start without it. We always write a port + password if not set,
  // then merge any user-provided fields on top.
  if (has('integrated')) {
    const integratedCfg = (out.integrated ?? {}) as Record<string, unknown>
    const existing = (integratedCfg.rcon as Record<string, unknown> | undefined) ?? {}
    let resolvedPort = existing.port as number | undefined
    if (!resolvedPort || (resolvedPort as number) <= 0) {
      resolvedPort = await findOpenPort()
      log(chalk`{cyan [bootstrap]} rcon port not set -- picked ${resolvedPort}`)
    }
    let resolvedPassword = existing.password as string | undefined
    if (!resolvedPassword) {
      resolvedPassword = randomBytes(16).toString('hex')
      log(chalk`{cyan [bootstrap]} rcon password not set -- generated random`)
    }
    integratedCfg.rcon = {
      ...existing,
      enabled: existing.enabled ?? true,
      port: resolvedPort,
      password: resolvedPassword,
    }
    out.integrated = integratedCfg as HostConfigInput
  }

  return out
}

/**
 * Scan 127.0.0.1 for a free TCP port. Returns the first bindable port
 * starting at 25575 (Minecraft's standard RCON port). Closes each probe
 * immediately so the returned port is free for the next caller.
 */
async function findOpenPort(): Promise<number> {
  const tryBind = (port: number): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const server = Bun.serve({
        port,
        fetch: () => new Response(),
      })
      const bound = server.port ?? port
      server.stop().then(
        () => resolve(bound),
        (err) => reject(err),
      )
    })
  for (let port = 25575; port < 65535; port++) {
    try {
      return await tryBind(port)
    } catch {
      // in use, try next
    }
  }
  throw new Error('No open port found in 25575-65534')
}
