/**
 * Shared rcon-srcds wrapper used by every host that supports
 * `executeRawCommand` over the Minecraft console protocol.
 *
 * Owns the underlying `Rcon` instance + auth + execute path. The
 * `destroy()` method uses `rcon.connection.destroy()` SYNCHRONOUSLY
 * (NOT `await rcon.disconnect()`) because `disconnect()` waits for the
 * socket's `close` event, which never fires when a request is in
 * flight as the JVM dies — the await would hang forever.
 *
 * Lifecycle for hosts that own the server lifecycle (integrated):
 *   1. Spawn the JVM.
 *   2. Wait for "Done (" + "RCON running on 0.0.0.0:PORT".
 *   3. `await rcon.authenticate(password)`.
 *   4. Use `rcon.execute(command)` for every console command.
 *   5. `rcon.destroy()` on shutdown.
 *
 * Lifecycle for hosts that don't own the server (ssh/ftp):
 *   1. Open the rcon-srcds client whenever `connect()` runs.
 *   2. Authenticate.
 *   3. Reconnect on socket close (unless `disconnect()` was called).
 */

import RconImport from 'rcon-srcds'
const Rcon = RconImport.default as unknown as new (opts: { host: string; port: number }) => {
  authenticate(password: string): Promise<boolean>
  execute(command: string): Promise<string | unknown>
  disconnect(): Promise<void>
  connection: import('node:net').Socket
}
type RconInstance = InstanceType<typeof Rcon>

import { HostAuthError } from './errors.js'

export class RconClient {
  private rcon: RconInstance | null = null
  /** True once `authenticate` has succeeded. False during reconnect or after `destroy`. */
  private connected = false
  /** Set by callers (e.g. integrated.stopServer) before triggering an
   *  intentional teardown so the socket close event doesn't trip the
   *  consumer's `onDisconnected` handler as a crash. */
  public closeExpected = false

  constructor(
    private readonly opts: { host: string; port: number; password: string },
  ) {}

  /** Open the socket and authenticate. Throws {@link HostAuthError} on
   *  bad password or transport error. */
  async authenticate(): Promise<void> {
    this.rcon = new Rcon({ host: this.opts.host, port: this.opts.port })
    try {
      const ok = await this.rcon.authenticate(this.opts.password)
      if (!ok) {
        throw new HostAuthError('RCON authentication failed')
      }
    } catch (err) {
      this.rcon = null
      if (err instanceof HostAuthError) throw err
      throw new HostAuthError(
        err instanceof Error ? err.message : 'RCON authentication failed',
      )
    }
    this.connected = true
  }

  isConnected(): boolean {
    return this.connected
  }

  /**
   * Run a console command. Returns the server's response string, or
   * `''` when the underlying `Rcon.execute` resolved without text.
   * Throws on transport error (caller can decide whether to retry).
   */
  async execute(command: string): Promise<string> {
    if (!this.rcon || !this.connected) {
      throw new Error('RCON is not connected')
    }
    const out = await this.rcon.execute(command)
    return typeof out === 'string' ? out : ''
  }

  /**
   * Synchronous socket teardown. Idempotent — safe to call from any
   * shutdown path. Does NOT block; the next `authenticate()` will
   * build a fresh socket.
   */
  destroy(): void {
    const rcon = this.rcon
    this.rcon = null
    this.connected = false
    if (!rcon) return
    try {
      rcon.connection?.destroy()
    } catch {
      // ignore
    }
  }

  /**
   * Install `onClose` + `onError` handlers on the socket so the
   * caller can react to unexpected drops (the JVM crashed, the
   * network went away, etc.). `closeExpected` short-circuits the
   * close handler so an intentional teardown doesn't surface as a
   * host-lost event.
   */
  installLivenessHandlers(opts: {
    onClose?: () => void
    onError?: (err: Error) => void
  }): void {
    const rcon = this.rcon
    if (!rcon) return
    rcon.connection.once('close', () => {
      const wasExpected = this.closeExpected
      this.connected = false
      this.closeExpected = false
      if (!wasExpected) {
        opts.onClose?.()
      }
    })
    rcon.connection.once('error', (err: Error) => {
      opts.onError?.(err)
    })
  }
}