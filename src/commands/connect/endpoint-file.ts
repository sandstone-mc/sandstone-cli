/**
 * Endpoint file: `<projectRoot>/.sandstone/connect.url`
 *
 * The daemon writes this on startup and removes it on shutdown. Consumer
 * commands read it to discover the WS URL + secret. Format is JSON:
 *
 *   {
 *     "version": 1,
 *     "url": "ws://127.0.0.1:54321",
 *     "secret": "<64 hex chars>",
 *     "hostType": "integrated",
 *     "displayName": "Integrated Fabric Server",
 *     "capabilities": { ... },
 *     "pid": 12345,
 *     "startedAt": "2026-09-15T...",
 *     "projectRoot": "/abs/path",
 *     "bind": "127.0.0.1",
 *     "port": 54321
 *   }
 *
 * Discovery safety:
 *  - Stale detection: if `pid` is not alive AND the file is older than
 *    {@link STALE_AFTER_MS}, the file is considered stale and can be
 *    cleared by a new daemon.
 *  - Secret: a 32-byte random hex string the WS subprotocol must echo
 *    during handshake. Defeats trivial hijacking on loopback.
 *  - File mode: 0600 on POSIX (best-effort; ignored on Windows).
 */

import { randomBytes } from 'node:crypto'
import { mkdir, stat as fsStat, unlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeTextAtomic } from '../../utils/fs.js'

/** Bump when the file shape changes incompatibly. */
export const ENDPOINT_VERSION = 1

/** After this much idle time, a non-alive-pid file is treated as stale. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export interface EndpointFile {
  version: typeof ENDPOINT_VERSION
  url: string
  secret: string
  hostType: string
  /** When the daemon is a composite of multiple providers, the list of member types. */
  hostTypes?: string[]
  displayName: string
  capabilities: Record<string, boolean>
  pid: number
  startedAt: string
  projectRoot: string
  bind: string
  port: number
}

/** `true` if a process with this pid is alive. Uses signal 0 on POSIX. */
export async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // `process.kill(pid, 0)` throws ESRCH when the pid doesn't exist and
    // EPERM when it exists but isn't ours. Either way the pid is "alive".
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

/** Generate a 32-byte random secret as 64 lowercase hex characters. */
export function generateSecret(): string {
  return randomBytes(32).toString('hex')
}

/** Default path: `<projectRoot>/.sandstone/connect.url`. */
export function endpointPath(projectRoot: string): string {
  return join(projectRoot, '.sandstone', 'connect.url')
}

/**
 * Atomically write the endpoint file. Creates `.sandstone/` if missing.
 * Refuses to clobber a symlink (prevents trivial redirects).
 */
export async function writeEndpoint(projectRoot: string, data: EndpointFile): Promise<void> {
  const path = endpointPath(projectRoot)
  const dir = join(projectRoot, '.sandstone')
  await mkdir(dir, { recursive: true })

  // Refuse to write through a symlink at the target. `lstat` follows
  // nothing — we see the path as it is on disk.
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink at ${path}`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await writeTextAtomic(path, JSON.stringify(data, null, 2), { mode: 0o600 })
}

/** Read + validate the endpoint file. Returns null when missing or invalid. */
export async function readEndpoint(projectRoot: string): Promise<EndpointFile | null> {
  const path = endpointPath(projectRoot)
  let raw: string
  try {
    raw = await Bun.file(path).text()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return validateEndpoint(parsed)
}

/**
 * Check whether an endpoint file describes a live daemon. Returns:
 *  - `'live'` — pid alive, file fresh → trust the endpoint
 *  - `'stale'` — pid dead + file older than STALE_AFTER_MS → safe to clear
 *  - `'live-recent'` — pid dead + file fresh → ambiguous (recent crash);
 *    caller can decide whether to wait or force-clear
 *  - `'missing'` — no file
 */
export type EndpointStatus = 'live' | 'stale' | 'live-recent' | 'missing'

export async function endpointStatus(projectRoot: string): Promise<EndpointStatus> {
  const data = await readEndpoint(projectRoot)
  if (!data) return 'missing'
  const alive = await pidAlive(data.pid)
  if (alive) return 'live'
  let ageMs: number
  try {
    const st = await fsStat(endpointPath(projectRoot))
    ageMs = Date.now() - st.mtimeMs
  } catch {
    return 'live-recent'
  }
  return ageMs > STALE_AFTER_MS ? 'stale' : 'live-recent'
}

/** Best-effort delete. Throws only on unexpected errors (not ENOENT). */
export async function deleteEndpoint(projectRoot: string): Promise<void> {
  const path = endpointPath(projectRoot)
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function validateEndpoint(v: unknown): EndpointFile | null {
  if (!isObject(v)) return null
  if (v.version !== ENDPOINT_VERSION) return null
  if (typeof v.url !== 'string') return null
  if (typeof v.secret !== 'string') return null
  if (typeof v.hostType !== 'string') return null
  if (v.hostTypes !== undefined && !Array.isArray(v.hostTypes)) return null
  if (typeof v.displayName !== 'string') return null
  if (!isObject(v.capabilities)) return null
  if (typeof v.pid !== 'number') return null
  if (typeof v.startedAt !== 'string') return null
  if (typeof v.projectRoot !== 'string') return null
  if (typeof v.bind !== 'string') return null
  if (typeof v.port !== 'number') return null
  return v as unknown as EndpointFile
}