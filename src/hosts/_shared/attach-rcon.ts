/**
 * Shared RCON attach helper.
 *
 * Three host providers (ssh, ftp, mcsmanager-login) and integrated
 * all expose `executeRawCommand` over a `RconClient` opened during
 * `connect()`. The protocol-level bits are identical; only the host
 * string and the post-success capabilities differ. This helper owns
 * the duplicate.
 */

import { Capability, type HostCapabilities } from '../types.js'
import { RconClient } from '../rcon-client.js'

/**
 * Open an RCON client (if `cfg` has `enabled !== false` and a port +
 * password), authenticate, and on success notify the host via the
 * provided setters. On failure the host is notified to clear the
 * rcon field, and a diagnostic is logged via `onLog`. Failure is
 * non-fatal — file / log capabilities continue to work without RCON.
 *
 * `label` is the connection target for diagnostic logging ("ssh",
 * "ftp", "mcsmanager-login", "integrated").
 *
 * Setter-based so the helper doesn't require public fields on every
 * host — the host's `rcon` and `capabilities` can stay private.
 */
export async function attachRconIfConfigured(
  cfg: { enabled?: boolean; port?: number; password?: string } | undefined,
  rconHost: string,
  label: string,
  onLog: (msg: string) => void,
  setters: {
    setRcon: (rcon: RconClient | null) => void
    addCapability: (cap: Capability) => void
  },
): Promise<void> {
  if (!cfg || cfg.enabled === false || !cfg.port || !cfg.password) return
  const rcon = new RconClient({ host: rconHost, port: cfg.port, password: cfg.password })
  try {
    await rcon.authenticate()
    setters.setRcon(rcon)
    setters.addCapability(Capability.ExecuteRawCommand)
    setters.addCapability(Capability.ExecuteRawCommandHasResponse)
  } catch (err) {
    setters.setRcon(null)
    onLog(
      `[${label}] RCON authenticate failed (${err instanceof Error ? err.message : err}) — executeRawCommand disabled`,
    )
  }
}