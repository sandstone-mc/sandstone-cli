/**
 * Bun-native filesystem helpers.
 *
 * Splits into two layers:
 *   - File ops (`fileExists`, `readText`, `readJSON`, `writeText`, `writeJSON`,
 *     `writeBytes`, `copyFile`, `deleteFile`) go through `Bun.file()`. Single
 *     syscall, hot-path optimized, safe to call inside tight loops.
 *   - Directory ops (`ensureDir`, `readDirEntries`, `pathExists`, `stat`,
 *     `lstat`, `symlink`, `readlink`, `unlink`, `remove`, `move`, `copyDir`,
 *     `copy`) go through `node:fs/promises`. Bun doesn't ship equivalents for
 *     `mkdir`, `readdir`, `lstat` etc., so we lean on Bun's fast `node:fs`
 *     shim — it's documented as "nearly complete" and faster than the Node
 *     implementation on every platform.
 *
 * Replaces `fs-extra` at every call site. Functions that read text return
 * `Promise<string>` (or `Promise<T>` for JSON), so the whole CLI can move to
 * promise-based async end to end.
 */
import { mkdir, readdir, stat, lstat, access, readlink, symlink as fsSymlink, unlink, rm, rename, cp, realpath as realpathRaw } from 'fs/promises'

// --- File ops (Bun.file) ----------------------------------------------------

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists()
}

export async function readText(path: string): Promise<string> {
  return Bun.file(path).text()
}

export async function readBytes(path: string): Promise<Buffer> {
  return Buffer.from(await Bun.file(path).arrayBuffer())
}

export async function readJSON<T = unknown>(path: string): Promise<T> {
  return Bun.file(path).json() as Promise<T>
}

/**
 * Write text to disk. Overwrites by default. Returns the number of bytes
 * written (matches `Bun.write`'s signature).
 */
export async function writeText(path: string, contents: string): Promise<number> {
  return Bun.write(path, contents)
}

/**
 * Write a JSON value to disk. Pretty-printed by default; pass `{ pretty: false }`
 * to emit compact JSON (matches the old `fs-extra` `writeFile` with a stringified
 * payload).
 */
export async function writeJSON(path: string, value: unknown, options: { pretty?: boolean; trailingNewline?: boolean } = {}): Promise<number> {
  const { pretty = true, trailingNewline = false } = options
  const json = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  return Bun.write(path, trailingNewline ? json + '\n' : json)
}

/**
 * Write raw bytes to disk. Accepts `Buffer | ArrayBuffer | Uint8Array` — the
 * common shapes produced by `Bun.file().bytes()`, `Bun.file().arrayBuffer()`,
 * or upstream sandstone pack code. Mirrors the old `fs.writeFile` behavior
 * without forcing callers to think about encoding.
 */
export async function writeBytes(path: string, contents: Buffer | ArrayBuffer | Uint8Array): Promise<number> {
  return Bun.write(path, contents)
}

/**
 * Copy a single file by reference. `Bun.write(dest, Bun.file(src))` is the
 * documented fast path — it does a `copy_file_range`/`fcopyfile` syscall when
 * the platform allows, falling back to a buffered read+write otherwise.
 */
export async function copyFile(src: string, dest: string): Promise<number> {
  return Bun.write(dest, Bun.file(src))
}

/**
 * Delete a file. `Bun.file(path).delete()` returns `void`; matches
 * `node:fs/promises.unlink` semantics but goes through Bun's optimized path.
 */
export async function deleteFile(path: string): Promise<void> {
  await Bun.file(path).delete()
}

// --- Path / dir ops (node:fs/promises) --------------------------------------

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function readDirEntries(path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }>> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory(),
    isFile: e.isFile(),
    isSymbolicLink: e.isSymbolicLink(),
  }))
}

/** Returns just the basenames of directory entries. */
export async function readDirNames(path: string): Promise<string[]> {
  return readdir(path)
}

/**
 * Encodings whose files should be read as text (`string`) rather than raw
 * bytes (`Buffer`). Covers the encodings Node and browsers can losslessly
 * round-trip into a JS string; everything else (binary files, `latin1`,
 * `base64`, …) falls through to the bytes path.
 */
export const textFormats = new Set<BufferEncoding>(['ascii', 'utf-16le', 'utf-8', 'utf16le', 'utf8'])

export async function fileStat(path: string) {
  return stat(path)
}

export async function fileLstat(path: string) {
  return lstat(path)
}

export async function readSymlink(path: string): Promise<string> {
  return readlink(path)
}

export async function createSymlink(target: string, linkPath: string, type: 'file' | 'dir' | 'junction' = 'dir'): Promise<void> {
  await fsSymlink(target, linkPath, type)
}

export async function unlinkPath(path: string): Promise<void> {
  await unlink(path)
}

export type RemoveOptions = { recursive?: boolean; force?: boolean }

/**
 * Remove a path. Defaults match `fs-extra.remove`: recursive + force, so
 * missing paths are a no-op and non-empty dirs get cleaned. Pass
 * `{ recursive: false }` for a strict single-target unlink.
 */
export async function remove(path: string, options: RemoveOptions = {}): Promise<void> {
  await rm(path, { recursive: options.recursive ?? true, force: options.force ?? true })
}

export async function move(src: string, dest: string, options: { overwrite?: boolean } = {}): Promise<void> {
  if (options.overwrite) {
    // `fs.rename` overwrites on POSIX and Windows-as-of-Node-16, but to be
    // explicit (and to handle cross-device moves), copy+rm fallback.
    try {
      await rename(src, dest)
      return
    } catch (err: any) {
      if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') {
        // Cross-device or other rename-fatal error → fall through to copy.
        if (err?.code !== 'EXDEV') throw err
      }
    }
    await cp(src, dest, { recursive: true })
    await rm(src, { recursive: true, force: true })
  } else {
    await rename(src, dest)
  }
}

export async function copyDir(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true })
}

export async function realpath(p: string): Promise<string> {
  return realpathRaw(p)
}
