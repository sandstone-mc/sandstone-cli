import type { SandstoneConfig } from 'sandstone'
import type { DaemonLogger } from '../commands/connect/logger.js'
export type { DaemonLogger } from '../commands/connect/logger.js'

export type HostType = (
  | 'ssh'
  | 'ftp'
  | 'integrated'
  | 'mcsmanager-login'
)

export abstract class HostProvider {
  abstract readonly type: HostType
  abstract readonly displayName: string
  abstract readonly capabilities: HostCapabilities
  protected readonly logger: DaemonLogger

  constructor(logger: DaemonLogger) {
    this.logger = logger
  }

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract isConnected(): boolean
  isRunning?(): boolean { return false }

  startServer?(): Promise<void>
  stopServer?(): Promise<void>
  readFile?(path: string): Promise<Buffer>
  readFileStream?(path: string): Promise<{ stream: ReadableStream<Uint8Array>; size?: number }>
  writeFile?(path: string, data: Buffer | string): Promise<void>
  writeFileStream?(path: string, opts?: { size?: number }): Promise<WritableStream<Uint8Array>>
  attachLog?(onChunk: HostLogHandler): Promise<LogSubscription>
  /** Minecraft console command */
  executeRawCommand?(command: string): Promise<string | undefined>
  onDisconnected?(handler: (reason: string) => void): () => void
}

export const Capability = {
  StartServer: 'startServer',
  StopServer: 'stopServer',
  ReadFile: 'readFile',
  WriteFile: 'writeFile',
  WriteFileStream: 'writeFileStream',
  AttachLog: 'attachLog',
  ExecuteRawCommand: 'executeRawCommand',
  ExecuteRawCommandHasResponse: 'executeRawCommandHasResponse',
} as const

export const HOST_TYPES = [
  'ssh',
  'ftp',
  'integrated',
  'mcsmanager-login',
] as const satisfies readonly HostType[]

export const KNOWN_HOST_TYPES: ReadonlySet<HostType> = new Set(HOST_TYPES)

export type Capability = (typeof Capability)[keyof typeof Capability]

export type HostCapabilities = Set<Capability>

export interface LogSubscription {
  unattach(): Promise<void>
}

export interface HostLogLine {
  line: string
  ts: number
  stream: 'stdout' | 'stderr'
}

export type HostLogHandler = (lines: HostLogLine[]) => void

export interface BaseHostConfig {
  projectRoot?: string
  verbose?: boolean
  sandstoneConfig?: SandstoneConfig
}

export interface RconConfig {
  enabled?: boolean
  password?: string
  /** Defaults to 25575 (Minecraft's standard RCON port). */
  port?: number
}

export interface SshHostConfig extends BaseHostConfig {
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string | Buffer
  serverDir: string
  /** Shell command to launch the server (e.g. `systemctl start minecraft@main`, `screen -dmS mc ./start.sh`). */
  startCommand: string
  /** Shell command to force-kill if graceful stop times out. */
  stopCommand: string
  /** Seconds to wait for graceful `stop` to exit before falling back. Default 30. */
  gracefulStopTimeoutSeconds?: number
  /** screen/tmux session name. Drives `stop` internally during graceful stop. */
  consoleSession?: string
  /** Path to the log file. Default: `${serverDir}/logs/latest.log`. */
  logPath?: string
  rcon?: RconConfig
}

export interface FtpHostConfig extends BaseHostConfig {
  host: string
  port?: number
  user: string
  password: string
  serverPath: string
  /** Path to the log file relative to serverPath. Default: 'logs/latest.log'. */
  logPath?: string
  /** How often to poll the log file for new bytes. Default 500ms. */
  pollIntervalMs?: number
  rcon?: RconConfig
}

export interface IntegratedHostConfig extends BaseHostConfig {
  /** Absolute path to the directory the CLI should manage the Fabric server inside. Default: `${projectRoot}/.sandstone/mc-server/`. */
  serverDir?: string
  verbose?: boolean
  serverPort?: number
  rcon?: {
    enabled?: boolean
    password?: string
    /** Defaults to 25575 (Minecraft's standard RCON port). */
    port?: number
  }
  /**
   * Sandstone version (e.g. "1.2.5"). The MC version + Java major are
   * derived from this via `sandstoneToMcVersion` + `requiredJavaMajor`.
   */
  sandstoneVersion?: string
  /**
   * Override MC version detection.
   */
  minecraftVersion?: string
  /** Fabric loader version. Default: latest stable. */
  fabricLoaderVersion?: string
  /** Path to sandstone project root (where sandstone.config.ts lives). */
  projectRoot: string
  /** Seconds to wait for graceful `stop` to exit before SIGTERM/SIGKILL. Default 30. */
  gracefulStopTimeoutSeconds?: number
  javaDir?: string
  preferSnapshot?: boolean
  mods?: IntegratedHostModsConfig
  world?:
    | 'void'
    | 'overworld'
    | { layers: Array<{ block: string; height: number }>; biome?: string }
}

export interface IntegratedHostModsConfig {
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
  additionalMods?: Array<{
    modrinthId?: string
    url?: string
    filename?: string
  }>
}

export interface McsManagerHostConfig extends BaseHostConfig {
  endpoint: string
  daemonId: string
  uuid: string
  /** Defaults to env-derived value. */
  username?: string
  /** base64-encoded, defaults to env-derived value. */
  password?: string
}

/** Capability-method shapes for compile-time introspection. */
export interface CapabilityMethods {
  startServer(): Promise<void>
  stopServer(): Promise<void>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Buffer | string): Promise<void>
  attachLog(onChunk: HostLogHandler): Promise<LogSubscription>
  executeRawCommand(command: string): Promise<string | undefined>
}

export type HostConfigInput = Partial<
  | SshHostConfig
  | FtpHostConfig
  | IntegratedHostConfig
  | McsManagerHostConfig
>

export const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  Capability.StartServer,
  Capability.StopServer,
  Capability.ReadFile,
  Capability.WriteFile,
  Capability.WriteFileStream,
  Capability.AttachLog,
  Capability.ExecuteRawCommand,
  Capability.ExecuteRawCommandHasResponse,
])

export function capabilitiesToRecord(caps: HostCapabilities): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const cap of ALL_CAPABILITIES) out[cap] = caps.has(cap)
  return out
}
