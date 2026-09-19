import RconImport from 'rcon-srcds'
type Rcon = RconImport.default
const Rcon = RconImport.default

import { HostAuthError, NotConnectedError } from '../errors.js'
import { Capability, type HostCapabilities, type HostProvider, type RconHostConfig } from '../types.js'

/**
 * RCON-only provider. Speaks the Minecraft console protocol directly via
 * `rcon-srcds`. No file I/O, no log attachment, no server lifecycle —
 * those belong to a sibling provider (SSH, FTP, etc) that the caller can
 * combine via `CompositeHost`.
 */
export class RconHost implements HostProvider {
  readonly type = 'rcon' as const
  readonly displayName = 'RCON'
  readonly capabilities: HostCapabilities = new Set([
    Capability.ExecuteRawCommand,
    Capability.ExecuteRawCommandHasResponse,
    Capability.StopServer,
  ])

  private rcon: Rcon | null = null
  private readonly config: RconHostConfig
  private connected = false
  private disconnectHandlers = new Set<(reason: string) => void>()

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
    // Watch the underlying socket for unexpected closes — the daemon uses
    // this to detect when an RCON-driven `stop` or server crash tears
    // down the connection.
    this.rcon.connection.once('close', () => {
      for (const h of this.disconnectHandlers) h('RCON connection closed')
    })
    this.rcon.connection.once('error', (err: Error) => {
      for (const h of this.disconnectHandlers) h(`RCON socket error: ${err.message}`)
    })
    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    // Detach the disconnect-listener set BEFORE killing so the close
    // event fired by our own disconnect doesn't trigger our own handler.
    this.disconnectHandlers.clear()
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

  onDisconnected(handler: (reason: string) => void): () => void {
    this.disconnectHandlers.add(handler)
    return () => {
      this.disconnectHandlers.delete(handler)
    }
  }

  async executeRawCommand(command: string): Promise<string> {
    if (!this.connected || !this.rcon) {
      throw new NotConnectedError('rcon')
    }
    const out = await this.rcon.execute(command)
    return typeof out === 'string' ? out : ''
  }

  /**
   * Soft stop — sends the `stop` command via RCON so the server runs
   * its normal shutdown sequence (saves worlds, broadcasts goodbye,
   * closes connections). The JVM exits a moment later, which fires
   * {@link onDisconnected} and triggers the daemon to tear down.
   */
  async stopServer(): Promise<void> {
    await this.executeRawCommand('stop')
  }
}

/** Factory used by the registry. */
export function createRconHost(config: RconHostConfig): HostProvider {
  return new RconHost(config)
}