/**
 * Direct server management — provider types.
 *
 * A `HostProvider` implements any subset of six capabilities. The registry +
 * composite compose partial providers into whatever combination the caller
 * wants (e.g. `[ssh, rcon]` for full control with RCON handling the MC
 * console, or `[ftp]` for read/write-only access).
 *
 * `executeRawCommand` is reserved for providers that speak the Minecraft
 * console protocol (RCON, MCSManager WebSocket stream/input, or a locally-
 * attached server's stdin). SSH does NOT implement it — SSH gives shell +
 * file access only.
 */

import type { SandstoneConfig } from 'sandstone'

export type HostType =
  | 'ssh'
  | 'rcon'
  | 'ftp'
  | 'local-client'
  | 'integrated'
  | 'mcsmanager-login'

/** Path on the host's filesystem. Provider-specific meaning. */
export type ServerPath = string

/**
 * Canonical list of every capability the host system understands. New
 * capabilities are added here AND in the {@link HostCapabilities} defaults
 * — the const is the single source of truth for both provider
 * declarations and runtime checks (`host.capabilities.has(Capability.X)`).
 */
export const Capability = {
  StartServer: 'startServer',
  StopServer: 'stopServer',
  ReadFile: 'readFile',
  WriteFile: 'writeFile',
  AttachLog: 'attachLog',
  ExecuteRawCommand: 'executeRawCommand',
  /**
   * True when `executeRawCommand` returns a non-empty response from the
   * underlying server transport (RCON, MCSManager WS, etc.). False when
   * the method is implemented but the response is unreliable / empty
   * (e.g. integrated writes to a child stdin and gets no echo). Lets
   * callers like `sand run --expect` skip the attach-and-await path
   * when a built-in response already signals success.
   */
  ExecuteRawCommandHasResponse: 'executeRawCommandHasResponse',
} as const

/** Every valid host type literal. */
export const HOST_TYPES = [
  'ssh',
  'rcon',
  'ftp',
  'local-client',
  'integrated',
  'mcsmanager-login',
] as const satisfies readonly HostType[]

/** Frozen set of valid host types — use for runtime validation. */
export const KNOWN_HOST_TYPES: ReadonlySet<HostType> = new Set(HOST_TYPES)

/** Union of every capability name string. */
export type Capability = (typeof Capability)[keyof typeof Capability]

/**
 * A host's set of declared capabilities. Stored as a `Set<Capability>`
 * so providers declare membership with a literal:
 *
 *   capabilities: new Set([Capability.StartServer, Capability.StopServer])
 *
 * and consumers check with `host.capabilities.has(Capability.X)`. Extensible
 * by adding a new key to {@link Capability} — every check site gets the
 * literal name back without touching call sites.
 */
export type HostCapabilities = Set<Capability>

export interface LogSubscription {
  /** Stop receiving chunks, release the underlying stream. Idempotent. */
  unattach(): Promise<void>
}

/** Per-chunk callback signature. Lines already split on `\n`. */
export type LogChunkHandler = (lines: string[]) => void

/** Fan-out chunk callback. `source` identifies which provider emitted the lines. */
export type LogChunkFanoutHandler = (source: HostType, lines: string[]) => void

/**
 * Base interface. Capability methods are optional on the type but each
 * provider implementation only defines the ones matching its capabilities.
 * Registry callers should consult `capabilities` first, then narrow with
 * the methods they need.
 */
export interface HostProvider {
  readonly type: HostType
  readonly displayName: string
  readonly capabilities: HostCapabilities

  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  /**
   * Whether the underlying server/process is currently running. Lets
   * `sand run` distinguish "we started it" (safe to send `stop` on
   * exit) from "someone else started it" (don't touch their session).
   * Optional — defaults to false if not implemented.
   */
  isRunning?(): boolean

  startServer?(): Promise<void>
  stopServer?(): Promise<void>
  readFile?(path: ServerPath): Promise<Buffer>
  writeFile?(path: ServerPath, data: Buffer | string): Promise<void>
  attachLog?(onChunk: LogChunkHandler): Promise<LogSubscription>
  /** Minecraft console command only. RCON / MCSManager WS / server stdin. */
  executeRawCommand?(command: string): Promise<string>
  /**
   * Subscribe to unexpected liveness loss — the spawned child exited,
   * the socket disconnected, etc. The daemon uses this to detect when
   * any member of a composite has gone away and trigger a coordinated
   * shutdown.
   *
   * `handler` receives a short reason string for logging. Returns an
   * unsubscribe function. Not invoked for graceful `disconnect()`
   * calls — only for unexpected exits.
   */
  onDisconnected?(handler: (reason: string) => void): () => void
}

/** Per-provider config shapes — exported from each provider module. */

/**
 * Fields every host config shares. Concrete configs extend this so
 * `HostConfigInput` (the CLI's parsed JSON type) carries `projectRoot`
 * uniformly without per-provider unions.
 */
export interface BaseHostConfig {
  /** Absolute path to the user's sandstone project root. Injected by `sand connect` / `sand run` from `--path`. */
  projectRoot?: string
  /** Set by `sand connect` so the integrated host prints lifecycle events. Ignored by other providers. */
  verbose?: boolean
  /**
   * The full `sandstone.config.ts` payload, auto-loaded by `sand connect`
   * and `sand run` from the project root. Optional — providers that
   * don't care about it can ignore the field. `undefined` means no
   * config was found at runtime (e.g. CLI invoked outside a project).
   */
  sandstoneConfig?: SandstoneConfig
}

export interface SshHostConfig extends BaseHostConfig {
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string | Buffer
  /** e.g. '/home/mc/server'. Used as base for logs + relative file paths. */
  serverDir: string
  /** Shell command to launch the server (e.g. `systemctl start minecraft@main`, `screen -dmS mc ./start.sh`). */
  startCommand: string
  /** Shell command to force-kill if graceful stop times out. */
  stopCommand: string
  /** Seconds to wait for graceful `stop` to exit before falling back. Default 30. */
  gracefulStopTimeoutSeconds?: number
  /** screen/tmux session name. Drives `stop` internally during graceful stop — NOT exposed via `executeRawCommand`. */
  consoleSession?: string
  /** Which strategy `attachLog` uses. Default: 'sftp-stream'. */
  attachStrategy?: 'sftp-stream' | 'tail'
  /** Path to the log file. Default: `${serverDir}/logs/latest.log`. */
  logPath?: string
}

export interface RconHostConfig extends BaseHostConfig {
  host: string
  port?: number
  password: string
}

export interface FtpHostConfig extends BaseHostConfig {
  host: string
  port?: number
  user: string
  password: string
  basePath?: string
  /** Path to the log file relative to basePath. Default: 'logs/latest.log'. */
  logPath?: string
  /** How often to poll the log file for new bytes. Default 500ms. */
  pollIntervalMs?: number
}

export interface LocalClientHostConfig extends BaseHostConfig {
  /** Path to the launcher-managed Minecraft dir (saves/, logs/, etc). Comes from MinecraftInstance.minecraftPath. */
  clientPath: string
  /** Override the default log location. Default: `${clientPath}/logs/latest.log`. */
  logPath?: string
}

export interface IntegratedHostConfig extends BaseHostConfig {
  /** Absolute path to the directory the CLI should manage the Fabric server inside. Default: `${projectRoot}/.sandstone/mc-server/`. */
  serverDir?: string
  /**
   * When true, the host logs lifecycle events to stdout
   * ("Done (" detected, mod updates applied, etc.). Useful for long-
   * running daemons where the operator wants to see the boot timeline;
   * noisy for one-shot `sand run` invocations. Default false.
   */
  verbose?: boolean
  /**
   * Minecraft server port written to `server.properties` as
   * `server-port=`. If `0` or omitted, the host scans starting at 25565
   * and writes the first bindable port it finds. Pass an explicit value
   * (e.g. 25565) to pin it.
   */
  serverPort?: number
  /**
   * RCON configuration. When enabled, the host writes `enable-rcon`,
   * `rcon.port`, and `rcon.password` to `server.properties` so the
   * JVM starts its RCON listener. Pair this with a separate `rcon`
   * provider in a composite daemon to drive the console over RCON.
   */
  rcon?: {
    enabled?: boolean
    password?: string
    /** Defaults to 25575 (Minecraft's standard RCON port). */
    port?: number
  }
  /**
   * Sandstone version (e.g. "1.2.5"). The MC version + Java major are
   * derived from this via `sandstoneToMcVersion` + `requiredJavaMajor`.
   * Mutually exclusive with `minecraftVersion` — set exactly one.
   */
  sandstoneVersion?: string
  /**
   * Override MC version detection. If set, skips the sandstone→MC mapping
   * and uses this version directly. Pass the FULL version string from
   * PrismLauncher's meta-launcher (e.g. "26.3" or "26.3-snapshot-10").
   */
  minecraftVersion?: string
  /** Fabric loader version. Default: latest stable. */
  fabricLoaderVersion?: string
  /** Path to the user's sandstone project root (where sandstone.config.ts lives). */
  projectRoot: string
  /** Seconds to wait for graceful `stop` to exit before SIGTERM/SIGKILL. Default 30. */
  gracefulStopTimeoutSeconds?: number
  /**
   * Directory the integrated host uses to cache downloaded JDKs. Defaults
   * to `<serverDir>/.java/` — keeping the JDK co-located with the managed
   * server. Auto-downloads the required Java major (per PrismLauncher's
   * meta-launcher) into this dir if no matching system Java is found.
   */
  javaDir?: string
  /**
   * When deriving MC version from a `sandstoneVersion`, accept the
   * latest snapshot/pre-release (e.g. "26.3-snapshot-10") instead of the
   * latest stable release. Default false — most callers want the
   * released MC version that corresponds to their sandstone minor.
   */
  preferSnapshot?: boolean
  /**
   * Auto-mod installation. Default mods are installed (best-effort) if
   * a Fabric-compatible version exists for the resolved MC version.
   * Per-mod toggles default to enabled; set any to `false` to skip that
   * one. `fabricApi: false` throws on connect — fabric-api is required
   * for the integrated host to function.
   *
   * `additionalMods` lets the caller add mods beyond the default set.
   * Each entry is either a Modrinth project id/slug OR a direct URL
   * to a JAR file. When both are present, `modrinthId` wins.
   */
  mods?: IntegratedHostModsConfig
  /**
   * World preset for the integrated server. Maps to server.properties:
   * `level-type=minecraft:flat` + a JSON `generator-settings` string.
   *
   * If omitted, Minecraft generates a fresh default overworld (no
   * overrides written to server.properties). Use `'void'` for a flat
   * superflat with the Void biome, `'overworld'` for a flat superflat
   * mimicking the default surface (bedrock + dirt + grass_block), or
   * a custom preset.
   */
  world?:
    | 'void'
    | 'overworld'
    | { layers: Array<{ block: string; height: number }>; biome?: string }
}

/**
 * Mod config for the integrated host. Each boolean defaults to true;
 * set to false to skip that mod. `fabric-api` cannot be disabled — it
 * is required for the server to boot.
 */
export interface IntegratedHostModsConfig {
  /** Required — fabric-api is mandatory. `false` throws on connect. */
  fabricApi?: boolean
  packtest?: boolean
  commandcrafter?: boolean
  worldgenDevtools?: boolean
  quickPack?: boolean
  lithium?: boolean
  krypton?: boolean
  ferriteCore?: boolean
  lazyDfu?: boolean
  scalablelux?: boolean
  /**
   * Extra mods. Each entry: either a Modrinth project id/slug
   * (`modrinthId`) or a direct URL to a `.jar` file (`url`). Optional
   * `filename` overrides the saved filename when downloading from URL.
   */
  additionalMods?: Array<{
    modrinthId?: string
    url?: string
    filename?: string
  }>
}

export interface McsManagerHostConfig extends BaseHostConfig {
  /** e.g. https://panel.example.com */
  endpoint: string
  daemonId: string
  uuid: string
  /** Optional overrides; defaults to env-derived values used by the legacy deploy script. */
  username?: string
  /** base64-encoded, matches the legacy script. */
  password?: string
}

/** Capability-method shapes used by CompositeHost's dispatch helper. */
export interface CapabilityMethods {
  startServer(): Promise<void>
  stopServer(): Promise<void>
  readFile(path: ServerPath): Promise<Buffer>
  writeFile(path: ServerPath, data: Buffer | string): Promise<void>
  attachLog(onChunk: LogChunkHandler): Promise<LogSubscription>
  executeRawCommand(command: string): Promise<string>
}

/**
 * Union of every host config shape, all fields optional. Lets the CLI
 * layer type `--host-config` JSON as a single value (`HostConfigInput`)
 * without per-provider casting. Each provider's factory narrows to its
 * own config type at the boundary.
 */
export type HostConfigInput = Partial<
  | SshHostConfig
  | RconHostConfig
  | FtpHostConfig
  | LocalClientHostConfig
  | IntegratedHostConfig
  | McsManagerHostConfig
>

/**
 * Composite host config — keyed map of host type to that type's config.
 * Used by `sand connect --host-type ssh,rcon --host-config '{...}'` to
 * instantiate multiple providers and wrap them in a {@link CompositeHost}.
 * When `--host-type` lists only one provider, use the flat
 * {@link HostConfigInput} instead — composite is for ≥2.
 */
export type CompositeHostConfigInput = Partial<Record<HostType, HostConfigInput>>

export const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  Capability.StartServer,
  Capability.StopServer,
  Capability.ReadFile,
  Capability.WriteFile,
  Capability.AttachLog,
  Capability.ExecuteRawCommand,
  Capability.ExecuteRawCommandHasResponse,
])

/** Merge capability sets with OR semantics. Used by CompositeHost. */
export function mergeCapabilities(sets: HostCapabilities[]): HostCapabilities {
  const out = new Set<Capability>()
  for (const set of sets) for (const cap of set) out.add(cap)
  return out
}

/** Serialize a `Set<Capability>` to the wire `Record<string, boolean>`. */
export function capabilitiesToRecord(caps: HostCapabilities): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const cap of ALL_CAPABILITIES) out[cap] = caps.has(cap)
  return out
}