/**
 * Shared host-bootstrap path used by both `sand connect` (long-lived
 * daemon) and `sand run` (one-shot direct invocation). Encapsulates:
 *  1. Per-type defaulting (latest sandstone version, RCON port/password
 *     auto-derived when integrated+rcon are paired).
 *  2. Two-phase member connection (StartServer-capable first, then the
 *     rest) so RCON-style members join only after their target server is
 *     up.
 *  3. Sequential `startServer()` calls for each StartServer-capable
 *     member — each must complete before the next so downstream
 *     members can connect to a running server.
 *  4. CompositeHost wrap when >1 member; single provider otherwise.
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
import { CompositeHost } from '../../hosts/composite.js'
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
  hostTypes: HostType[]
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
  const hostTypes = [...opts.hostTypes]
  const perHostConfig = await resolveDefaults(hostTypes, opts.perHostConfig, opts.silent ?? false)

  // Auto-load the project's sandstone.config.ts (if any) and thread it
  // through to every host so providers that care about the pack name,
  // save options, etc. don't have to re-import the file themselves.
  const autocfg = await loadSandstoneConfig(process.cwd())
  if (autocfg) {
    for (const type of hostTypes) {
      const existing = perHostConfig[type]
      if (!existing) continue
      if (!('sandstoneConfig' in existing)) {
        perHostConfig[type] = { ...existing, sandstoneConfig: autocfg }
      }
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
      hostTypes.push('local-client')
      const existing = perHostConfig['local-client']
      perHostConfig['local-client'] = {
        ...(existing ?? {}),
        ...localClientCfg,
      }
    }
  }

  // Instantiate every requested provider.
  const instances: Array<{ type: HostType; member: HostProvider }> = []
  for (const type of hostTypes) {
    const factory = getProvider(type)
    if (!factory) {
      throw new BootstrapError(`Unknown host type: ${type}`, 'no-factory')
    }
    const memberConfig = perHostConfig[type]
    let member: HostProvider
    try {
      member = factory.create(memberConfig)
    } catch (e) {
      throw new BootstrapError(
        `Failed to construct host '${type}': ${e instanceof Error ? e.message : String(e)}`,
        'host-failed',
      )
    }
    instances.push({ type, member })
  }

  // Two-phase connect: StartServer-capable first (their `connect()`
  // doesn't require a running server), then the rest.
  const startServerMembers = instances.filter((i) =>
    i.member.capabilities.has('startServer'),
  )
  const otherMembers = instances.filter((i) => !i.member.capabilities.has('startServer'))

  for (const { type, member } of startServerMembers) {
    try {
      await member.connect()
    } catch (e) {
      throw new BootstrapError(
        `Failed to connect host '${type}': ${e instanceof Error ? e.message : String(e)}`,
        'host-failed',
      )
    }
  }

  // Sequential startServer calls so downstream members can connect.
  const started: HostType[] = []
  const spawnedByUs: HostType[] = []
  for (const { type, member } of startServerMembers) {
    if (!member.startServer) continue
    try {
      await member.startServer()
      started.push(type)
      // integrated exposes `weStartedThisCall()`; other StartServer
      // providers (none today, but future-proof) wouldn't have it and
      // we skip them.
      const maybeIntegrated = member as { weStartedThisCall?: () => boolean }
      if (maybeIntegrated.weStartedThisCall?.()) {
        spawnedByUs.push(type)
      }
    } catch (e) {
      throw new BootstrapError(
        `Failed to start server on '${type}': ${e instanceof Error ? e.message : String(e)}`,
        'start-failed',
      )
    }
  }

  // Connect the remaining members.
  for (const { type, member } of otherMembers) {
    try {
      await member.connect()
    } catch (e) {
      throw new BootstrapError(
        `Failed to connect host '${type}': ${e instanceof Error ? e.message : String(e)}`,
        'host-failed',
      )
    }
  }

  const members = instances.map((i) => i.member)
  const host: HostProvider = members.length === 1 ? members[0]! : new CompositeHost(members)
  return { host, members, perHostConfig, startedMembers: started, spawnedByUs }
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

  // integrated+rcon auto-config (port/password/host).
  if (has('integrated') && has('rcon')) {
    const integratedCfg = (out.integrated ?? {}) as Record<string, unknown>
    const rconCfg = (out.rcon ?? {}) as {
      host?: string
      port?: number
      password?: string
    }
    let resolvedPort = rconCfg.port
    if (!resolvedPort || resolvedPort <= 0) {
      resolvedPort = await findOpenPort()
      log(chalk`{cyan [bootstrap]} rcon port not set -- picked ${resolvedPort}`)
    }
    let resolvedPassword = rconCfg.password
    if (!resolvedPassword) {
      resolvedPassword = randomBytes(16).toString('hex')
      log(chalk`{cyan [bootstrap]} rcon password not set -- generated random`)
    }
    const existing = (integratedCfg.rcon as Record<string, unknown> | undefined) ?? {}
    integratedCfg.rcon = {
      ...existing,
      enabled: existing.enabled ?? true,
      port: existing.port ?? resolvedPort,
      password: existing.password ?? resolvedPassword,
    }
    rconCfg.host = rconCfg.host ?? (integratedCfg.host as string | undefined) ?? '127.0.0.1'
    rconCfg.port = resolvedPort
    rconCfg.password = resolvedPassword
    out.rcon = rconCfg as HostConfigInput
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
