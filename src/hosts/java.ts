/**
 * Java runtime discovery + auto-download.
 *
 * The integrated Fabric server needs the JVM that matches Minecraft's
 * `compatibleJavaMajors` (per PrismLauncher's meta-launcher). On a fresh
 * dev machine, the user might not have that JDK installed. This module:
 *
 *  1. Scans well-known locations for an existing `java` binary.
 *  2. Reads its major version from `java -version`.
 *  3. If none match the required major, downloads Temurin from Adoptium's
 *     CDN into a local cache directory.
 *  4. Returns the resolved `JavaInstall` so the spawn target is known.
 *
 * Adoptium's API: `https://api.adoptium.net/v3/binary/latest/{major}/ga/{os}/{arch}/jdk/hotspot/normal/eclipse`
 * — returns a binary stream (tar.gz on linux, zip on windows, etc).
 */

import { join as pathJoin } from 'node:path'

import { ghFetchText } from '../utils/github.js'
import * as fs from '../utils/fs.js'
import { run, which } from '../utils/shell.js'

export interface JavaInstall {
  /** Absolute path to the `java` binary. */
  path: string
  /** Major version (e.g. 21 for "21.0.4"). */
  major: number
  /** Full version string from `java -version` (best-effort). */
  version: string
}

/**
 * Resolve the required Java major for a Minecraft version. Authoritative
 * source is PrismLauncher's meta-launcher (`net.minecraft/{version}.json`
 * → `compatibleJavaMajors[0]`). Throws if the lookup fails or returns no
 * major.
 */
export async function requiredJavaMajor(minecraftVersion: string): Promise<number> {
  const url = `https://raw.githubusercontent.com/PrismLauncher/meta-launcher/master/net.minecraft/${minecraftVersion}.json`
  const text = await ghFetchText(url)
  const json = JSON.parse(text) as { compatibleJavaMajors?: number[] }
  const major = json.compatibleJavaMajors?.[0]
  if (typeof major === 'number') return major
  throw new Error(
    `PrismLauncher meta-launcher has no compatibleJavaMajors for Minecraft ${minecraftVersion}`,
  )
}

/**
 * Scan common locations for any `java` binary and read its major version.
 * Returns all matches; the caller picks the one matching the required major.
 */
export async function findSystemJava(): Promise<JavaInstall[]> {
  const pathJava = which('java')
  const candidates = pathJava
    ? [pathJava, ...(await collectSystemJavaPaths())]
    : await collectSystemJavaPaths()
  const results: JavaInstall[] = []
  for (const javaPath of candidates) {
    try {
      const info = await readJavaVersion(javaPath)
      results.push(info)
    } catch {
      // ignore — not a usable Java install
    }
  }
  return results
}

/**
 * Find the first Java install whose major matches `requiredMajor`.
 *
 * Priority order:
 *  1. The global PATH `java` (the user's primary JDK). Probed first —
 *     if `java -version` reports the required major, we're done and
 *     never touch the filesystem elsewhere.
 *  2. Cached download in `javaDir`.
 *  3. Other system candidates (JAVA_HOME, SDKMAN, system JVM roots).
 *     Only scanned if PATH java doesn't match.
 *  4. Adoptium download into `javaDir`.
 *
 * `javaDir` is the local cache for downloaded JDKs. Already-downloaded
 * versions are reused on subsequent calls.
 */
export async function ensureJava(
  requiredMajor: number,
  javaDir: string,
): Promise<JavaInstall> {
  // 1. PATH java — no filesystem walk beyond `which`. If it matches,
  //    we're done. This is the only probe on the happy path.
  const pathJava = which('java')
  if (pathJava) {
    try {
      const info = await readJavaVersion(pathJava)
      if (info.major === requiredMajor) return info
    } catch {
      // PATH java is broken — fall through to the slow path.
    }
  }

  // 2. Cache hit (a previously-downloaded JDK in `javaDir`).
  await fs.ensureDir(javaDir)
  const cached = pathJoin(javaDir, `java-${requiredMajor}`, 'bin', javaBinaryName())
  if (await fs.fileExists(cached)) {
    try {
      const info = await readJavaVersion(cached)
      if (info.major === requiredMajor) return info
    } catch {
      // cached install is corrupt; fall through to re-download
    }
  }

  // 3. Walk the rest of the filesystem (JAVA_HOME, SDKMAN, system JVM
  //    roots). Only happens if PATH java didn't match.
  for (const javaPath of await collectSystemJavaPaths()) {
    try {
      const info = await readJavaVersion(javaPath)
      if (info.major === requiredMajor) return info
    } catch {
      // not usable; keep looking
    }
  }

  // 4. Download + extract from Adoptium.
  return await downloadAdoptium(requiredMajor, javaDir)
}

/**
 * Download a Temurin JDK from Adoptium's CDN, extract into `javaDir`,
 * and return the resolved JavaInstall. Archives are cached so a second
 * call doesn't re-download.
 */
async function downloadAdoptium(major: number, javaDir: string): Promise<JavaInstall> {
  const { os, arch } = detectOsArch()
  const apiBase = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`
  const archivePath = pathJoin(javaDir, `.jdk-${major}.tar.gz`)

  const extractDir = pathJoin(javaDir, `java-${major}`)
  if (!(await fs.fileExists(pathJoin(extractDir, 'bin', 'java')))) {
    // Download the archive only if we don't already have it (cache hit).
    if (!(await fs.fileExists(archivePath))) {
      const resp = await fetch(apiBase)
      if (!resp.ok) {
        throw new Error(
          `Adoptium download failed for Java ${major} (${os}/${arch}): HTTP ${resp.status}`,
        )
      }
      await Bun.write(archivePath, resp)
    }

    // Adoptium tarballs extract as `jdk-{ver}+{build}/bin/java` directly
    // under the cwd. Find whatever was extracted and rename it to our
    // canonical `java-{ver}/` path.
    await extractTarGz(archivePath, javaDir)
    const extracted = await findExtractedJdk(javaDir)
    if (!extracted) {
      throw new Error(
        `Adoptium archive extracted but no jdk-* directory found under ${javaDir}`,
      )
    }
    // If `java-{major}` already exists as a stale dir or empty leftover,
    // remove it so the rename can proceed.
    await fs.remove(extractDir, { recursive: true, force: true })
    await fs.move(extracted, extractDir)

    // Clean up the tarball — we have the extracted dir now.
    await fs.remove(archivePath, { force: true }).catch(() => {})
  }

  const javaPath = pathJoin(extractDir, 'bin', 'java')
  return await readJavaVersion(javaPath)
}

/**
 * Locate the directory Adoptium just extracted. The archive's top entry
 * is always `jdk-{major}+{build}` (e.g. `jdk-21.0.4+7`). We don't try to
 * pin the build number — just pick the first `jdk-*` directory we find.
 */
async function findExtractedJdk(javaDir: string): Promise<string | null> {
  const names = await fs.readDirNames(javaDir).catch(() => [] as string[])
  for (const entry of names) {
    if (entry.startsWith('jdk-')) {
      return pathJoin(javaDir, entry)
    }
  }
  return null
}

// ---------------------------------------------------------------------

function detectOsArch(): { os: string; arch: string } {
  const platform = process.platform
  const a = process.arch
  let os = 'linux'
  if (platform === 'darwin') os = 'mac'
  else if (platform === 'win32') os = 'windows'
  let arch = 'x64'
  if (a === 'arm64') arch = 'aarch64'
  return { os, arch }
}

/** Java binary name — `java.exe` on Windows, `java` elsewhere. */
function javaBinaryName(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

/** Common system Java install roots per platform. */
function systemJvmRoots(): string[] {
  if (process.platform === 'win32') {
    // Common Windows Java install locations. ProgramFiles may be 32 or 64
    // bit depending on the OS install; we check both.
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    return [
      pathJoin(pf, 'Java'),
      pathJoin(pf86, 'Java'),
      pathJoin(pf, 'Eclipse Adoptium'),
      pathJoin(pf, 'Microsoft\\jdk-'),
    ]
  }
  return ['/usr/lib/jvm', '/opt/jvm']
}

/**
 * Build a list of candidate Java binaries from system locations
 * (JAVA_HOME, SDKMAN, common system JVM roots). Does NOT include the
 * global PATH `java` — that's probed separately by `ensureJava` so the
 * filesystem walk here is skipped on the happy path.
 */
async function collectSystemJavaPaths(): Promise<string[]> {
  const paths: string[] = []
  // JAVA_HOME — binary name differs per platform.
  const jh = process.env.JAVA_HOME
  if (jh) paths.push(pathJoin(jh, 'bin', javaBinaryName()))
  // SDKMAN — POSIX/macOS only.
  if (process.platform !== 'win32') {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const sdkman = pathJoin(home, '.sdkman', 'candidates', 'java')
    if (await fs.pathExists(sdkman)) {
      for (const entry of await fs.readDirNames(sdkman).catch(() => [] as string[])) {
        paths.push(pathJoin(sdkman, entry, 'bin', 'java'))
      }
    }
  }
  // Common system JVM roots per platform.
  for (const root of systemJvmRoots()) {
    if (!(await fs.pathExists(root))) continue
    for (const entry of await fs.readDirNames(root).catch(() => [] as string[])) {
      // The root itself might be the JDK (e.g. `C:\Program Files\Microsoft\jdk-17.0.10.7-hotspot`)
      // rather than a parent directory listing installed JDKs. Detect and
      // add the right binary either way.
      if (entry.toLowerCase().endsWith(javaBinaryName())) {
        paths.push(pathJoin(root, entry))
      } else {
        paths.push(pathJoin(root, entry, 'bin', javaBinaryName()))
      }
    }
  }
  return paths
}

/**
 * Run `<javaPath> -version` and parse the major version. Output looks like:
 *   openjdk version "21.0.4" 2024-07-16
 *   OpenJDK Runtime Environment Temurin-21.0.4+11 (...)
 * We pull the first quoted integer from the first line.
 */
async function readJavaVersion(javaPath: string): Promise<JavaInstall> {
  // `java -version` prints to stderr by convention; capture both.
  const result = await run(javaPath, ['-version'], { throws: false })
  if (result.exitCode !== 0) {
    throw new Error(`java -version exited with code ${result.exitCode}`)
  }
  const stderr = await result.stderr
  const stdout = await result.stdout
  const text = `${stdout.toString()}\n${stderr.toString()}`
  const match = text.match(/version\s+"(\d+)(?:\.\d+)*"/)
  if (!match) {
    throw new Error(`Couldn't parse java -version output: ${text.slice(0, 200)}`)
  }
  const major = Number(match[1])
  // Java 8 reports as "1.8.0_xxx" → major=1, but the real major is 8.
  const normalizedMajor = major === 1 ? 8 : major
  const versionMatch = text.match(/"([^"]+)"/)
  return {
    path: javaPath,
    major: normalizedMajor,
    version: versionMatch?.[1] ?? `${normalizedMajor}`,
  }
}

/**
 * Extract a `.tar.gz` archive. Uses Bun's native `Archive` API — no
 * shell-out to system `tar`.
 */
async function extractTarGz(archive: string, destDir: string): Promise<void> {
  const bytes = await fs.readBytes(archive)
  const archive_ = new Bun.Archive(bytes)
  await archive_.extract(destDir)
}