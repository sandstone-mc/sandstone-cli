import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { Worker } from 'node:worker_threads'
import { execSync } from 'child_process'
import chalk from 'chalk-template'

/** Hash a string or buffer using MD5 */
export function hash(data: string | Buffer): string {
  return crypto.createHash('md5').update(data).digest('hex')
}

/**
 * Worker source for the SHA-256 hash. Inlined as a string and loaded with
 * `new Worker(code, { eval: true })` so the bundle ships as a single file
 * (Bun's bundler doesn't extract `new URL(..., import.meta.url)` workers
 * for this CLI's single-entry `--outdir=lib` build, so a sibling .js file
 * would 404 at runtime).
 *
 * The worker streams chunks (peak memory O(chunkSize), not O(fileSize)),
 * destroys its read stream in `finally`, and posts a single hex digest
 * (or `{ __error }`) before exiting.
 */
const HASH_WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'

const { filePath } = workerData
;(async () => {
  const hasher = createHash('sha256')
  const stream = createReadStream(filePath)
  try {
    for await (const chunk of stream) {
      hasher.update(chunk)
    }
    parentPort.postMessage(hasher.digest('hex'))
  } catch (err) {
    parentPort.postMessage({ __error: err.message })
  } finally {
    stream.destroy()
  }
})()
`

/**
 * SHA-256 a file's bytes and return the hex digest.
 *
 * Runs in a dedicated worker thread so the file read + hashing never
 * touches the main thread's heap. The parent terminates the worker once
 * the digest is in hand — leaving no live FD, no lingering thread, and no
 * closure keeping the worker reachable after the promise resolves.
 */
export async function sha256File(p: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let settled = false
    const worker = new Worker(HASH_WORKER_SOURCE, {
      eval: true,
      workerData: { filePath: p },
    })
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      // Detach all listeners before terminate so an in-flight `exit` event
      // can't fire the rejection path again on a thread we already tore down.
      worker.removeAllListeners()
      worker.terminate().catch(() => { /* already gone */ })
      fn()
    }
    worker.once('message', (msg: unknown) => {
      if (msg && typeof msg === 'object' && '__error' in (msg as object)) {
        finish(() => reject(new Error((msg as { __error: string }).__error)))
      } else {
        finish(() => resolve(msg as string))
      }
    })
    worker.once('error', (err) => {
      finish(() => reject(err))
    })
    worker.once('exit', (code) => {
      finish(() => reject(new Error(`sha256 worker exited with code ${code}`)))
    })
  })
}

/** Detect the package manager used in a project directory via lockfile */
export async function detectPackageManager(dir: string): Promise<'bun' | 'pnpm' | 'yarn' | 'npm' | null> {
  if (fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun'
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn'
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm'
  return null
}

/** Normalize a path to use forward slashes */
export const normalizePath = (p: string) => p.replaceAll('\\', '/')

export function hasYarn(): boolean {
  try {
    execSync('yarn --version')
    return true
  } catch (error) {
    return false
  }
}
export function hasPnpm(): boolean {
  try {
    execSync('pnpm --version')
    return true
  } catch (error) {
    return false
  }
}
export function hasBun(): boolean {
  try {
    execSync('bun --version')
    return true
  } catch (error) {
    return false
  }
}

export function hasGh(): boolean {
  try {
    execSync('gh --version')
    return true
  } catch {
    return false
  }
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Check if symlinks can be used on this system.
 * Returns true on non-Windows platforms.
 * On Windows, tests if symlinking actually works (requires admin or developer mode).
 */
export async function canUseSymlinks(): Promise<boolean> {
  if (os.platform() !== 'win32') {
    return true
  }

  const testDir = path.join(os.tmpdir(), `symlink-test-${Date.now()}`)
  const targetPath = path.join(testDir, 'target')
  const linkPath = path.join(testDir, 'link')

  try {
    await fs.promises.mkdir(testDir)
    await fs.promises.mkdir(targetPath)
    await fs.promises.writeFile(path.join(targetPath, 'test.txt'), 'symlink-test')
    await fs.promises.symlink(targetPath, linkPath, 'dir')

    // Verify the symlink actually works by reading through it
    const content = await fs.promises.readFile(path.join(linkPath, 'test.txt'), 'utf-8')
    return content === 'symlink-test'
  } catch {
    return false
  } finally {
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Get the .minecraft path
 */
export function getMinecraftPath(): string {
  function getMCPath(): string {
    switch (os.platform()) {
    case 'win32':
      return path.join(os.homedir(), 'AppData/Roaming/.minecraft')
    case 'darwin':
      return path.join(os.homedir(), 'Library/Application Support/minecraft')
    case 'linux':
    default:
      return path.join(os.homedir(), '.minecraft')
    }
  }

  const mcPath = getMCPath()

  if (!fs.existsSync(mcPath)) {
    throw new Error('Unable to locate the .minecraft folder. Please specify it manually.')
  }

  return mcPath
}

export function getWorldsList(clientPath?: string): string[] {
  const mcPath = clientPath || getMinecraftPath()
  const savesPath = path.join(mcPath, 'saves')

  return fs.readdirSync(
    savesPath,
    { withFileTypes: true }
  ).filter((f) => f.isDirectory).map((f) => f.name)
}

// --- 1. Utilities to convert Union to Tuple (Standard TS Magic) ---
type UnionToIntersection<U> =
  (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never

type LastOf<T> =
  UnionToIntersection<T extends any ? () => T : never> extends () => (infer R) ? R : never

type Push<T extends any[], V> = [...T, V]

// Recursively moves items from Union T to a Tuple
type UnionToTuple<T, L = LastOf<T>, N = [T] extends [never] ? true : false> =
  true extends N ? [] : Push<UnionToTuple<Exclude<T, L>>, L>

// --- 2. The PowerSet Logic (Linear Recursion) ---
// We iterate over the tuple of keys. For every key, we double the result:
// (Current Results) | (Current Results + New Key)
type PowerSet<T, Keys extends any[] = UnionToTuple<keyof T>> =
  Keys extends [infer Head, ...infer Rest]
  ? PowerSet<T, Rest> | (
    Head extends keyof T
    ? { [K in Head]: NonNullable<T[K]> } & PowerSet<T, Rest>
    : never
  )
  : Record<string, never> // Base case: Empty object

// --- 3. Prettify Helper ---
// Merges intersections ({a:1} & {b:2}) into clean objects ({a:1, b:2})
// and distributes over the union to make tooltips readable.
type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

/**
 * Helper to add key-value pairs to an object if the values are not undefined.
 *
 * @returns An object with the key-value pairs if the values are not undefined, otherwise an empty object.
 */
export function add<O extends Record<string, any>>(obj: O): Prettify<PowerSet<O>> {
  const filtered = {}

  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (value !== undefined) {
      // @ts-ignore
      filtered[key] = value
    }
  }

  // @ts-ignore
  return filtered
}
