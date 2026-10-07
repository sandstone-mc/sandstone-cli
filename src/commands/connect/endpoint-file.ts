import { join } from 'path'
import { lstat } from 'node:fs/promises'
import { randomBytes } from 'crypto'


import * as fs from '../../utils/fs.js'

export const ENDPOINT_VERSION = 1

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export interface EndpointFile {
  version: typeof ENDPOINT_VERSION
  url: string
  secret: string
  hostType: string
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

export function generateSecret(): string {
  return randomBytes(32).toString('hex')
}

export function endpointPath(projectRoot: string): string {
  return join(projectRoot, '.sandstone', 'connect.url')
}

export async function writeEndpoint(projectRoot: string, data: EndpointFile): Promise<void> {
  const path = endpointPath(projectRoot)
  const dir = join(projectRoot, '.sandstone')
  await fs.ensureDir(dir)
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink at ${path}`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await fs.writeTextAtomic(path, JSON.stringify(data, null, 2), { mode: 0o600 })
}

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
    const st = await fs.fileStat(endpointPath(projectRoot))
    ageMs = Date.now() - st.mtimeMs
  } catch {
    return 'live-recent'
  }
  return ageMs > STALE_AFTER_MS ? 'stale' : 'live-recent'
}

export async function deleteEndpoint(projectRoot: string, ourPid?: number): Promise<void> {
  const path = endpointPath(projectRoot)
  if (ourPid !== undefined) {
    try {
      const existing = await readEndpoint(projectRoot)
      if (existing && existing.pid !== ourPid) {
        // Another daemon owns this file. Only leave it alone if that
        // pid is genuinely alive; a dead owner means the file is
        // orphaned and safe to remove.
        const alive = await pidAlive(existing.pid)
        if (alive) return
      }
    } catch {}
  }
  try {
    await fs.unlinkPath(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function validateEndpoint(v: unknown): EndpointFile | null {
  if (!isObject(v)) return null
  if (v.version !== ENDPOINT_VERSION) return null
  if (typeof v.url !== 'string') return null
  if (typeof v.secret !== 'string') return null
  if (typeof v.hostType !== 'string') return null
  if (typeof v.displayName !== 'string') return null
  if (!isObject(v.capabilities)) return null
  if (typeof v.pid !== 'number') return null
  if (typeof v.startedAt !== 'string') return null
  if (typeof v.projectRoot !== 'string') return null
  if (typeof v.bind !== 'string') return null
  if (typeof v.port !== 'number') return null
  return v as unknown as EndpointFile
}