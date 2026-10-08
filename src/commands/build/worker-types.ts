import type { resetSandstonePack, SandstoneConfig, SandstonePack } from 'sandstone'

export type WorkerLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace'

export interface BuildResultPayload {
  success: boolean,
  error?: string,
  resourceCounts: { functions: number, other: number },
  timestamp: number,
  sandstoneConfig?: SandstoneConfig,
  activeSaveConfig?: SandstoneConfig['saveOptions'],
  /** Pack registered at least one TestMCFunction */
  hasTests: boolean,
}

export interface WorkerRequest {
  id: number,
  entryPath: string,
  optsJson: string,
  folder: string,
  watching: boolean,
  resolvedFolder: string,
  resolvedRoot: string,
  lastBuildFailed: boolean,
}

// TODO: Give these a `type` field and make them less cancer
export type WorkerResponse =
  | { id: number, ok: true, result: BuildResultPayload }
  | { id: number, __error: string }
  | { id: number, __needsRestart: true, reason: string }
  | { __log: { level: WorkerLevel, line: string } }

export interface ModShape {
  _buildCommand: (
    opts: unknown, // TODO: Typessss
    folder: string,
    ctx: unknown, // TODO: Typesss
  ) => Promise<{
    success: boolean,
    error?: string,
    resourceCounts: { functions: number, other: number },
    timestamp: number,
    sandstoneConfig?: SandstoneConfig,
    sandstonePack?: SandstonePack,
    resetSandstonePack?: typeof resetSandstonePack,
    activeSaveConfig?: SandstoneConfig['saveOptions'],
  }>,
}