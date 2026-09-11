import RconImport from 'rcon-srcds'
type Rcon = RconImport.default
const Rcon = RconImport.default

import { HostAuthError, NotConnectedError } from '../errors.js'
import type { HostCapabilities, HostProvider, RconHostConfig } from '../types.js'
import { ALL_CAPABILITIES_OFF } from '../types.js'

/**
 * RCON-only provider. Speaks the Minecraft console protocol directly via
 * `rcon-srcds`. No file I/O, no log attachment, no server lifecycle —
 * those belong to a sibling provider (SSH, FTP, etc) that the caller can
 * combine via `CompositeHost`.
 */
export class RconHost implements HostProvider {
  readonly type = 'rcon' as const
  readonly displayName = 'RCON'
  readonly capabilities: HostCapabilities = {
    ...ALL_CAPABILITIES_OFF,
    executeRawCommand: true,
  }

  private rcon: Rcon | null = null
  private readonly config: RconHostConfig
  private connected = false

  constructor(config: RconHostConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const { host, port, password } = this.config
    this.rcon = new Rcon({ host, port })
    try {
      const ok = await this.rcon.authenticate(password)
      if (!ok) {
        throw new HostAuthError('RCON authentication failed')
      }
    } catch (err) {
      // rcon-srcds rejects with an Error on bad password/timeout. Surface it
      // as HostAuthError so callers can branch on type.
      this.rcon = null
      throw new HostAuthError(
        err instanceof Error ? err.message : 'RCON authentication failed',
      )
    }
    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    try {
      await this.rcon?.disconnect()
    } finally {
      this.rcon = null
      this.connected = false
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  async executeRawCommand(command: string): Promise<string> {
    if (!this.connected || !this.rcon) {
      throw new NotConnectedError('rcon')
    }
    const out = await this.rcon.execute(command)
    return typeof out === 'string' ? out : ''
  }
}

/** Factory used by the registry. */
export function createRconHost(config: RconHostConfig): HostProvider {
  return new RconHost(config)
}