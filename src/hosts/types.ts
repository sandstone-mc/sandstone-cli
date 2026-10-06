import type { DaemonLogger } from '../commands/connect/logger.js'
export type { DaemonLogger } from '../commands/connect/logger.js'

import type { SandstoneConnect } from 'sandstone'

export type HostType = SandstoneConnect['HostType']

export type SshHostConfig = SandstoneConnect['SshHostConfig']

export type FtpHostConfig = SandstoneConnect['FtpHostConfig']

export type IntegratedHostConfig = SandstoneConnect['IntegratedHostConfig']

export type IntegratedHostModsConfig = SandstoneConnect['IntegratedHostModsConfig']

export type McsManagerHostConfig = SandstoneConnect['McsManagerHostConfig']

export type HostConfigInput = Partial<
  | SshHostConfig
  | FtpHostConfig
  | IntegratedHostConfig
  | McsManagerHostConfig
>

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

/** Capability-method shapes for compile-time introspection. */
export interface CapabilityMethods {
  startServer(): Promise<void>
  stopServer(): Promise<void>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Buffer | string): Promise<void>
  attachLog(onChunk: HostLogHandler): Promise<LogSubscription>
  executeRawCommand(command: string): Promise<string | undefined>
}

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
