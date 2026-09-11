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

export type HostType =
  | 'ssh'
  | 'rcon'
  | 'ftp'
  | 'local-client'
  | 'integrated'
  | 'mcsmanager-login'

/** Path on the host's filesystem. Provider-specific meaning. */
export type ServerPath = string

/** Declared at registration time so callers + composite can pick without probing. */
export interface HostCapabilities {
  startServer: boolean
  stopServer: boolean
  readFile: boolean
  writeFile: boolean
  attachLog: boolean
  executeRawCommand: boolean
}

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

  startServer?(): Promise<void>
  stopServer?(): Promise<void>
  readFile?(path: ServerPath): Promise<Buffer>
  writeFile?(path: ServerPath, data: Buffer | string): Promise<void>
  attachLog?(onChunk: LogChunkHandler): Promise<LogSubscription>
  /** Minecraft console command only. RCON / MCSManager WS / server stdin. */
  executeRawCommand?(command: string): Promise<string>
}

/** Per-provider config shapes — exported from each provider module. */

export interface SshHostConfig {
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

export interface RconHostConfig {
  host: string
  port?: number
  password: string
}

export interface FtpHostConfig {
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

export interface LocalClientHostConfig {
  /** Path to the launcher-managed Minecraft dir (saves/, logs/, etc). Comes from MinecraftInstance.minecraftPath. */
  clientPath: string
  /** Override the default log location. Default: `${clientPath}/logs/latest.log`. */
  logPath?: string
}

export interface IntegratedHostConfig {
  /** Absolute path to the directory the CLI should manage the Fabric server inside. Default: `${projectRoot}/.sandstone/mc-server/`. */
  serverDir?: string
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

export interface McsManagerHostConfig {
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

export const ALL_CAPABILITIES_OFF: HostCapabilities = {
  startServer: false,
  stopServer: false,
  readFile: false,
  writeFile: false,
  attachLog: false,
  executeRawCommand: false,
}

export const ALL_CAPABILITIES_ON: HostCapabilities = {
  startServer: true,
  stopServer: true,
  readFile: true,
  writeFile: true,
  attachLog: true,
  executeRawCommand: true,
}

/** Merge a list of capability sets with OR semantics. Used by CompositeHost. */
export function mergeCapabilities(sets: HostCapabilities[]): HostCapabilities {
  const result: HostCapabilities = { ...ALL_CAPABILITIES_OFF }
  for (const set of sets) {
    for (const key of Object.keys(result) as Array<keyof HostCapabilities>) {
      if (set[key]) result[key] = true
    }
  }
  return result
}