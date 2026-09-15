import { join as pathJoin } from 'node:path'
import { createHash } from 'node:crypto'

import { NotConnectedError } from '../errors.js'
import { ensureJava, requiredJavaMajor } from '../java.js'
import {
  downloadMod,
  downloadUrl,
  findLatestVersionsForHashes,
  findModVersion,
  primaryFile,
  type ModrinthVersion,
} from '../modrinth.js'
import { sandstoneToMcVersion } from '../sandstone-version.js'
import * as fs from '../../utils/fs.js'
import { ghFetchText } from '../../utils/github.js'
import { spawn as shellSpawn } from '../../utils/shell.js'
import type {
  HostCapabilities,
  HostProvider,
  IntegratedHostConfig,
  IntegratedHostModsConfig,
  LogChunkHandler,
  LogSubscription,
  ServerPath,
} from '../types.js'
import { ALL_CAPABILITIES_OFF } from '../types.js'
import { ChildProcessWithoutNullStreams } from 'node:child_process'

/** sha512 file hash of a tracked mod (Modrinth-installed or URL-installed). */
type ModSha512 = string

/** How an installed mod was sourced. URL-installed mods aren't auto-updated. */
type ModSource = 'modrinth' | 'url'

/**
 * Per-mod metadata persisted in `sandstone_manifest.json`. Keyed by
 * filename so the host can rename + remove files cleanly when an
 * update changes the version's primary filename.
 */
interface InstalledModInfo {
  source: ModSource
  sha512: ModSha512
  // Modrinth-only — populated for `source: 'modrinth'`, undefined otherwise.
  versionId?: string
  versionNumber?: string
  projectId?: string
  datePublished?: string
}

/** Shape of `sandstone_manifest.json` in the integrated server dir. */
interface SandstoneManifest {
  installedFabricLoader?: string
  installerVersion?: string
  minecraftVersion?: string
  installedAt?: string
  /** ISO-8601 timestamp of the last successful mod update check. */
  lastModUpdateCheck?: string
  /** Mods currently present in `<serverDir>/mods/`. Keyed by filename. */
  installedMods?: Record<string, InstalledModInfo>
}

/**
 * Minimum gap between two consecutive mod update checks on the same
 * server. Throttles the bulk POST to /version_files/update — the API
 * is rate-limited per-IP and we want connects to stay cheap.
 */
const ONE_HOUR_MS = 60 * 60 * 1000

/**
 * Integrated provider — CLI-managed local Fabric server inside
 * `${projectRoot}/.sandstone/mc-server/`. The CLI downloads the Fabric
 * server jar (Mojang server + Fabric loader) on first connect, writes
 * `eula.txt` automatically (this is a dev tool — Mojang's EULA is
 * accepted unconditionally by the user invoking the CLI), and exposes
 * the running JVM process via the standard host capabilities:
 *
 *  - `startServer` / `stopServer` — spawn + terminate the JVM.
 *  - `readFile` / `writeFile` — direct `node:fs/promises` against `serverDir`.
 *  - `attachLog` — tails the child's stdout + the file under
 *    `${serverDir}/logs/latest.log` (Minecraft writes both; we expose
 *    stdout since it's the live stream).
 *  - `executeRawCommand` — writes the command to the child's stdin.
 *    Response capture is best-effort: we read N stdout chunks after each
 *    write and return whatever shows up within the response window.
 */
export class IntegratedHost implements HostProvider {
  readonly type = 'integrated' as const
  readonly displayName = 'Integrated Fabric Server'
  readonly capabilities: HostCapabilities = {
    ...ALL_CAPABILITIES_OFF,
    startServer: true,
    stopServer: true,
    readFile: true,
    writeFile: true,
    attachLog: true,
    executeRawCommand: true,
  }

  private readonly config: IntegratedHostConfig
  private readonly serverDir: string
  private readonly javaDir: string
  private java: Awaited<ReturnType<typeof ensureJava>> | null = null
  /** Resolved MC version (with snapshot/pre-release suffix) — drives installer args. */
  private resolvedMinecraftVersion: string | null = null
  private resolvedMinecraftType: 'release' | 'snapshot' | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private connected = false
  // Shared line-splitter state — written by startServer's chunk handler,
  // read by attachLog (replay) + forwarded to active handlers. Reset
  // every startServer.
  private logBuffer: string[] = []
  private partialLine = ''
  /**
   * Multiple concurrent `attachLog` subscribers are supported — each
   * call returns its own subscription. New lines are fanned out to every
   * entry in the set.
   */
  private logHandlers = new Set<LogChunkHandler>()
  private doneDetected = false
  /** Resolver for the in-flight startServer readiness promise. */
  private resolveReady: (() => void) | null = null
  /**
   * One-shot matcher for the next line matching a regex. Set by
   * `awaitLogLine` and resolved by the line-splitter when a matching
   * line arrives. Used to confirm that a console command's response
   * was seen in the log before continuing.
   */
  private pendingLineMatcher: { pattern: RegExp; resolve: (line: string) => void } | null = null
  /**
   * True if the server's world dir had no `level.dat` at connect time,
   * meaning Minecraft will generate a fresh world on first start. We
   * automatically run a small setup script after "Done (" to lay down
   * the stone spawn platform + central cobblestone block so the player
   * doesn't fall through to the void. Set to false once we've run the
   * setup so subsequent starts don't re-place blocks in a saved world.
   */
  private needsInitialWorldSetup = false

  constructor(config: IntegratedHostConfig) {
    this.config = config
    this.serverDir =
      config.serverDir ?? pathJoin(config.projectRoot, '.sandstone', 'mc-server')
    this.javaDir = config.javaDir ?? pathJoin(this.serverDir, '.java')
  }

  async connect(): Promise<void> {
    if (this.connected) return
    await fs.ensureDir(this.serverDir)
    // Dev tool — accept Mojang's EULA unconditionally on the user's behalf.
    await this.ensureEulaAccepted()
    // Write server.properties with the configured world preset BEFORE
    // the server starts. Minecraft reads this on first launch and
    // generates the world according to `level-type` + `generator-settings`.
    // No-op when `world` is unset — Minecraft generates a fresh default
    // overworld. We only overwrite the keys we own; user edits to other
    // server.properties keys are preserved.
    await this.writeServerProperties()
    // Resolve the MC version + java major up-front. Either `sandstoneVersion`
    // (we derive MC via PrismLauncher's index.json) or explicit
    // `minecraftVersion` (caller takes responsibility for the version string).
    const { version: mcVersion, type: mcType } = await this.resolveMinecraftVersion()
    this.resolvedMinecraftVersion = mcVersion
    this.resolvedMinecraftType = mcType
    // Resolve a JVM that matches the Minecraft version up-front. The
    // Fabric installer needs the *same* JVM we'll later run the server
    // with — installing on Java 17 then launching on Java 25 leaves the
    // loader bundled with bytecode it can't read.
    const major = await requiredJavaMajor(mcVersion)
    this.java = await ensureJava(major, this.javaDir)
    // Decide whether to (re)install the Fabric server. Re-install when:
    //  - `fabric-server-launch.jar` is missing (first run), OR
    //  - `sandstone_manifest.json` records an older loader version than
    //    the current latest stable. The latest loader is fully
    //    backwards-compatible, so a bump is always safe — we delete the
    //    installer's outputs and re-run.
    const latestLoader = await fetchLatestFabricLoader()
    const manifestPath = pathJoin(this.serverDir, 'sandstone_manifest.json')
    let installedLoader: string | null = null
    let manifestMcVersion: string | null = null
    try {
      const raw = await fs.readText(manifestPath)
      const manifest = JSON.parse(raw) as {
        installedFabricLoader?: string
        minecraftVersion?: string
      }
      installedLoader = manifest.installedFabricLoader ?? null
      manifestMcVersion = manifest.minecraftVersion ?? null
    } catch {
      // No manifest — first run.
    }
    const stale =
      installedLoader === null || compareSemver(installedLoader, latestLoader) < 0
    if (stale) {
      if (installedLoader !== null) {
        console.log(
          `test: installed Fabric Loader ${installedLoader} is older than latest ${latestLoader}, re-installing`,
        )
        await this.clearFabricInstall()
      }
      await this.installFabricServer(latestLoader)
      // Only wipe + re-install mods when the MC version changes. A
      // Fabric loader upgrade doesn't require touching mods.
      if (manifestMcVersion !== mcVersion) {
        console.log(
          `test: MC version changed (${manifestMcVersion ?? 'none'} → ${mcVersion}) — re-resolving mods`,
        )
        await this.clearMods()
        await this.installMods(mcVersion)
      }
    }
    // Backfill the manifest's installedMods map for existing servers that
    // pre-date auto-update tracking — hash every jar in mods/ and ask
    // Modrinth which version each one is. No-op when already populated.
    await this.ensureModsTracked(mcVersion)
    // Auto-update pass. Throttled by ONE_HOUR_MS via lastModUpdateCheck
    // in the manifest — connect() calls within an hour of a prior check
    // (or a fresh installMods pass) skip the POST entirely.
    await this.checkModUpdates(mcVersion)
    // Track whether this connection will generate a fresh world — if the
    // world dir had no level.dat before connect, we'll lay down the
    // spawn platform after the server finishes booting.
    const worldDir = pathJoin(this.serverDir, 'world')
    this.needsInitialWorldSetup = !(await fs.fileExists(pathJoin(worldDir, 'level.dat')))
    this.connected = true
  }

  /**
   * Resolve the MC version + type from config. Either `sandstoneVersion`
   * (mapped via PrismLauncher's index.json) or `minecraftVersion` (used
   * verbatim) — never both.
   */
  private async resolveMinecraftVersion(): Promise<{
    version: string
    type: 'release' | 'snapshot'
  }> {
    if (this.config.sandstoneVersion && this.config.minecraftVersion) {
      throw new Error(
        'Pass either sandstoneVersion OR minecraftVersion, not both',
      )
    }
    if (this.config.sandstoneVersion) {
      const mc = await sandstoneToMcVersion(
        this.config.sandstoneVersion,
        this.config.preferSnapshot ?? false,
      )
      // sandstoneToMcVersion only matches 'release' | 'snapshot', so the
      // type narrowing is safe here.
      return { version: mc.version, type: mc.type as 'release' | 'snapshot' }
    }
    if (this.config.minecraftVersion) {
      // The caller passed a literal MC version. We don't have a separate
      // signal for release-vs-snapshot here; treat anything with `-snapshot`
      // or `-pre`/`-rc` in the string as a snapshot so the installer gets
      // `-snapshot`. Plain releases (e.g. "26.3") stay "release".
      const isSnapshot = /-(snapshot|pre|rc)\d*$/i.test(this.config.minecraftVersion)
      return {
        version: this.config.minecraftVersion,
        type: isSnapshot ? 'snapshot' : 'release',
      }
    }
    throw new Error(
      'Either sandstoneVersion or minecraftVersion is required — pass one in IntegratedHostConfig',
    )
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return
    const child = this.child
    if (child) {
      // Wait for the child to actually exit so the test script doesn't
      // return while the JVM still holds port 25565 — the next test run
      // would fail to bind and Minecraft would auto-shut down.
      const exited = waitForExit(child)
      child.kill('SIGTERM')
      // SIGKILL safety net after 10s.
      const killer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 10_000)
      killer.unref?.()
      try {
        await exited
      } finally {
        clearTimeout(killer)
      }
    }
    this.child = null
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async startServer(): Promise<void> {
    this.requireConnected('integrated')
    if (this.child && !this.child.killed) {
      throw new Error('Server is already running')
    }
    if (!this.java) throw new Error('Java not resolved — connect() failed?')

    const jar = pathJoin(this.serverDir, 'fabric-server-launch.jar')
    if (!(await fs.fileExists(jar))) {
      throw new Error(
        `Fabric server jar not found at ${jar} — run the Fabric installer first`,
      )
    }

    // Reset log state for the new run.
    this.logBuffer = []
    this.partialLine = ''
    this.doneDetected = false
    this.resolveReady = null
    const { spawn: nodeSpawn } = await import('node:child_process')
    this.child = nodeSpawn(
      this.java.path,
      ['-jar', 'fabric-server-launch.jar', 'nogui'],
      {
        cwd: this.serverDir,
        shell: true,
        // stdin is a pipe so we can write the `stop` console command
        // for graceful shutdown. `detached: true` puts the JVM in its
        // own process group so signal propagation from Bun doesn't race
        // the `stop` command path.
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      },
    )

    // Shared line-splitter feeding `logBuffer` + the active handler +
    // the "Done (" detector. Each chunk gets text-decoded + split.
    const processChunk = (chunk: Buffer | Uint8Array | string) => {
      const text =
        typeof chunk === 'string'
          ? chunk
          : new TextDecoder('utf-8').decode(chunk, { stream: true })
      this.partialLine += text
      const lines = this.partialLine.split('\n')
      this.partialLine = lines.pop() ?? ''
      if (lines.length === 0) return
      for (const line of lines) {
        if (this.logBuffer.length >= 10_000) this.logBuffer.shift()
        this.logBuffer.push(line)
        // Resolve a pending one-shot matcher, if any. Used by
        // `awaitLogLine` to confirm a console command's response arrived
        // before continuing.
        const matcher = this.pendingLineMatcher
        if (matcher && matcher.pattern.test(line)) {
          console.log(
            `[integrated] line matched pending matcher (${matcher.pattern}): ${JSON.stringify(line)}`,
          )
          this.pendingLineMatcher = null
          matcher.resolve(line)
        }
      }
      for (const handler of this.logHandlers) {
        try {
          handler(lines)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('integrated logHandler threw:', err)
        }
      }
      if (!this.doneDetected) {
        for (const line of lines) {
          if (line.includes('Done (')) {
            this.doneDetected = true
            console.log(
              `[${this.serverDir}] startServer: detected "Done (" — server is ready`,
            )
            this.resolveReady?.()
            break
          }
        }
      }
    }

    // Spawn stream-pump tasks for stdout + stderr. Errors are caught
    // silently — the early-exit check below will reject startServer
    // if either stream errors out.
    void (async () => {
      try {
        for await (const chunk of this.child!.stdout) {
          processChunk(chunk)
        }
      } catch {
        // ignore
      }
    })()
    void (async () => {
      try {
        for await (const chunk of this.child!.stderr) {
          processChunk(chunk)
        }
      } catch {
        // ignore
      }
    })()

    // Resolve as soon as "Done (" is detected (callback above). Reject
    // if the child exits before that.
    const child = this.child
    await new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      child!.once('exit', (code: number | null) => {
        if (!this.doneDetected) {
          reject(new Error(`Server exited early with code ${code}`))
        }
      })
    })

    if (this.needsInitialWorldSetup) {
      this.needsInitialWorldSetup = false
      console.log(
        `[${this.serverDir}] startServer: running initial world setup (fill + setblock)`,
      )
      const fillSucceeded = this.detectLogLine(/Successfully filled 1089 block\(s\)/)
      console.log(
        `[${this.serverDir}] startServer: writing 'fill 24 -61 24 -8 -61 -8 stone'`,
      )
      await this.executeRawCommand('fill 24 -61 24 -8 -61 -8 stone')
      console.log(
        `[${this.serverDir}] startServer: awaiting fill response (matcher set: ${fillSucceeded !== undefined})`,
      )
      await fillSucceeded
      console.log(
        `[${this.serverDir}] startServer: fill response received`,
      )
      const setblockSucceeded = this.detectLogLine(/Changed the block at 8, -61, 8/)
      console.log(
        `[${this.serverDir}] startServer: writing 'setblock 8 -61 8 cobblestone'`,
      )
      await this.executeRawCommand('setblock 8 -61 8 cobblestone')
      console.log(
        `[${this.serverDir}] startServer: awaiting setblock response`,
      )
      await setblockSucceeded
      console.log(
        `[${this.serverDir}] startServer: setblock response received`,
      )
    }
  }

  async stopServer(): Promise<void> {
    this.requireConnected('integrated')
    const child = this.child
    if (!child || child.killed) return
    const timeoutMs =
      (this.config.gracefulStopTimeoutSeconds ?? 30) * 1000

    // Order: write `stop` first, THEN set up the timeout + wait. The
    // timeout is a safety net for the case where `stop` doesn't lead to
    // an exit within `gracefulStopTimeoutSeconds`. The promise resolves
    // on whichever fires first.
    const exited = waitForExit(child)
    console.log(`[${this.serverDir}] stopServer: writing "stop" to JVM stdin`)
    child.stdin?.write('stop\n')

    // 2. Set up the timeout. Only fires if `stop` didn't cause exit
    //    within `gracefulStopTimeoutSeconds`. We don't currently have a
    //    configurable hard-kill command (no shell layer in integrated),
    //    so escalation is SIGTERM → SIGKILL via the child process.
    const killTimer = setTimeout(() => {
      console.log(
        `[${this.serverDir}] stopServer: server still alive after ${timeoutMs}ms — escalating to SIGTERM`,
      )
      if (!child.killed) {
        child.kill('SIGTERM')
        // Escalate to SIGKILL if still alive 5s later.
        const finalTimer = setTimeout(() => {
          console.log(
            `[${this.serverDir}] stopServer: server still alive after SIGTERM — escalating to SIGKILL`,
          )
          if (!child.killed) child.kill('SIGKILL')
        }, 5_000)
        finalTimer.unref?.()
      }
    }, timeoutMs)
    killTimer.unref?.()

    // 3. Wait for the child to exit.
    await exited
    clearTimeout(killTimer)
    this.child = null
  }

  async readFile(path: ServerPath): Promise<Buffer> {
    this.requireConnected('integrated')
    const full = pathJoin(this.serverDir, path)
    return await fs.readBytes(full)
  }

  async writeFile(path: ServerPath, data: Buffer | string): Promise<void> {
    this.requireConnected('integrated')
    const full = pathJoin(this.serverDir, path)
    await fs.ensureDir(pathJoin(full, '..'))
    await (typeof data === 'string'
      ? fs.writeText(full, data)
      : fs.writeBytes(full, data))
  }

  /**
   * Register a one-shot detector for a line matching `pattern` in the
   * JVM's stdout. Returns a promise that resolves when a matching line
   * arrives. Existing logBuffer is scanned first; if a match is already
   * buffered, the promise resolves immediately.
   *
   * Used by the first-start setup to confirm a console command's
   * response was processed before continuing — pattern should match the
   * exact expected confirmation line.
   */
  private detectLogLine(pattern: RegExp): Promise<string> {
    console.log(`[integrated] detectLogLine registered: ${pattern}`)
    for (const line of this.logBuffer) {
      if (pattern.test(line)) {
        console.log(
          `[integrated] detectLogLine matched in buffer: ${JSON.stringify(line)}`,
        )
        return Promise.resolve(line)
      }
    }
    return new Promise<string>((resolve) => {
      this.pendingLineMatcher = { pattern, resolve }
    })
  }

  async attachLog(onChunk: LogChunkHandler): Promise<LogSubscription> {
    this.requireConnected('integrated')
    // attachLog is callable both before and after startServer. Multiple
    // concurrent subscribers are supported — each call adds to the set
    // and gets its own subscription. Lines received after this point
    // (whether the child is already spawning or about to spawn) flow
    // through the shared line-splitter to every entry.

    // Replay any lines the splitter has already buffered so callers
    // that attach after spawn see the full boot log.
    if (this.logBuffer.length > 0) {
      try {
        onChunk([...this.logBuffer])
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('integrated logHandler threw during replay:', err)
      }
    }
    this.logHandlers.add(onChunk)
    const self = this

    return {
      async unattach() {
        if (!self.logHandlers.has(onChunk)) return
        self.logHandlers.delete(onChunk)
        // Flush any trailing partial line so callers see it.
        if (self.partialLine.length > 0) {
          onChunk([self.partialLine])
          self.partialLine = ''
        }
      },
    }
  }

  async executeRawCommand(command: string): Promise<string> {
    this.requireConnected('integrated')
    const child = this.child
    if (!child) throw new Error('Server is not running')
    // Write the command to the JVM's stdin and return immediately.
    // The Fabric server doesn't reliably echo console-command output to
    // stdout (especially with mods that silence it), so response capture
    // is unreliable here. Callers that need to observe the response
    // should use `attachLog` to capture stdout from the moment the
    // command is written onward.
    const stdin = child.stdin as unknown as NodeJS.WritableStream | null
    stdin?.write(`${command}\n`)
    return ''
  }

  // ---------------------------------------------------------------------

  private requireConnected(label: string): void {
    if (!this.connected) throw new NotConnectedError(label)
  }

  /**
   * Read `sandstone_manifest.json` from the server dir. Returns an empty
   * object when the file is missing or unreadable — every field is
   * optional, so callers can treat the result as "what we know so far".
   */
  private async readManifest(): Promise<SandstoneManifest> {
    const manifestPath = pathJoin(this.serverDir, 'sandstone_manifest.json')
    try {
      const raw = await fs.readText(manifestPath)
      return JSON.parse(raw) as SandstoneManifest
    } catch {
      return {}
    }
  }

  /** Persist `sandstone_manifest.json`. Pretty-printed for diffability. */
  private async writeManifest(manifest: SandstoneManifest): Promise<void> {
    await fs.writeText(
      pathJoin(this.serverDir, 'sandstone_manifest.json'),
      JSON.stringify(manifest, null, 2),
    )
  }

  /**
   * Compute a file's sha512 hash as a lowercase hex string. Used to
   * populate the manifest's per-mod hash + to bulk-query Modrinth's
   * update endpoint.
   */
  private async sha512OfFile(absPath: string): Promise<string> {
    const bytes = await fs.readBytes(absPath)
    return createHash('sha512').update(bytes).digest('hex')
  }

  /**
   * First-connect bootstrap: when `manifest.installedMods` is empty
   * (e.g. an existing server pre-dating auto-update tracking), hash
   * every jar in `mods/` and ask Modrinth which ones it recognizes.
   * Recognized jars are recorded as `source: 'modrinth'`, unrecognized
   * as `source: 'url'`. The sha512 we record is always the on-disk
   * hash — `/version_files/update` returns the *latest* matching
   * version per hash, not the version we have installed, so we use it
   * only to disambiguate source, never to record metadata. Version
   * metadata is filled in by `installMods` on the next re-install.
   *
   * Idempotent: no-op when entries already exist. Also clears
   * `lastModUpdateCheck` on the first bootstrap so the throttle
   * doesn't suppress the very first update check.
   */
  private async ensureModsTracked(mcVersion: string): Promise<void> {
    const manifest = await this.readManifest()
    if (manifest.installedMods && Object.keys(manifest.installedMods).length > 0) {
      return
    }
    const modsDir = pathJoin(this.serverDir, 'mods')
    if (!(await fs.pathExists(modsDir))) return

    const entries: Array<{ filename: string; sha512: string }> = []
    for (const entry of await fs.readDirNames(modsDir)) {
      if (!entry.endsWith('.jar')) continue
      const full = pathJoin(modsDir, entry)
      try {
        const sha512 = await this.sha512OfFile(full)
        entries.push({ filename: entry, sha512 })
      } catch {
        // skip unreadable jars
      }
    }
    if (entries.length === 0) return

    const installedMods: Record<string, InstalledModInfo> = {}
    let modrinthHashes: Set<string> = new Set()
    try {
      const latest = await findLatestVersionsForHashes(
        entries.map((e) => e.sha512),
        mcVersion,
      )
      modrinthHashes = new Set(latest.keys())
    } catch (err) {
      // Network failure: every jar falls through to `source: 'url'`,
      // which loses auto-update for these files until they're re-installed
      // by `installMods`. Better than giving up on the manifest entirely.
      // eslint-disable-next-line no-console
      console.warn(`mod tracking bootstrap failed: ${err}`)
    }

    for (const { filename, sha512 } of entries) {
      installedMods[filename] = modrinthHashes.has(sha512)
        ? { source: 'modrinth', sha512 }
        : { source: 'url', sha512 }
    }

    manifest.installedMods = installedMods
    // Reset the throttle so the just-populated entries get checked. The
    // upcoming `checkModUpdates` call will set `lastModUpdateCheck`
    // itself (success or no-op).
    delete manifest.lastModUpdateCheck
    await this.writeManifest(manifest)
  }

  /**
   * Auto-update pass. Skips if the last check was within ONE_HOUR_MS,
   * otherwise POSTs every Modrinth-sourced mod's sha512 to
   * `/version_files/update` and downloads newer versions. Updates the
   * manifest with new sha512 / version metadata + bumps
   * `lastModUpdateCheck` to `now`, regardless of whether anything
   * changed (so a no-op check still satisfies the throttle).
   */
  private async checkModUpdates(mcVersion: string): Promise<void> {
    const manifest = await this.readManifest()

    // Throttle: skip only when we have both a recent timestamp AND a
    // populated installedMods map. Missing fields = the manifest's
    // tracking state is incomplete (pre-feature install, partial write,
    // etc.) — treat that as "never checked" and run.
    const hasMods =
      !!manifest.installedMods && Object.keys(manifest.installedMods).length > 0
    if (manifest.lastModUpdateCheck && hasMods) {
      const elapsed = Date.now() - new Date(manifest.lastModUpdateCheck).getTime()
      if (elapsed < ONE_HOUR_MS) return
    }

    const installedMods = manifest.installedMods ?? {}
    const tracked = Object.entries(installedMods).filter(
      ([, info]) => info.source === 'modrinth' && info.sha512,
    )
    if (tracked.length === 0) {
      // Nothing to check against — bump the timestamp so we don't loop
      // on every connect when mods/ is empty or all entries are URL.
      manifest.lastModUpdateCheck = new Date().toISOString()
      await this.writeManifest(manifest)
      return
    }

    const hashToEntry = new Map(tracked.map(([filename, info]) => [info.sha512!, { filename, info }]))
    let updates: Map<string, ModrinthVersion>
    try {
      updates = await findLatestVersionsForHashes(
        Array.from(hashToEntry.keys()),
        mcVersion,
      )
    } catch (err) {
      // Don't bump the timestamp on failure — let the next connect retry.
      // eslint-disable-next-line no-console
      console.warn(`mod update check failed: ${err}`)
      return
    }

    const modsDir = pathJoin(this.serverDir, 'mods')
    let changed = false
    const next: Record<string, InstalledModInfo> = { ...installedMods }
    for (const [sha, version] of updates) {
      const entry = hashToEntry.get(sha)
      if (!entry) continue
      const newFile = primaryFile(version)
      if (newFile.hashes.sha512 === sha) continue // already current
      console.log(
        `[integrated] mod update: ${entry.filename} ${entry.info.versionNumber ?? '?'} → ${version.version_number}`,
      )
      await downloadMod(version, pathJoin(modsDir, newFile.filename))
      if (newFile.filename !== entry.filename) {
        try {
          await fs.remove(pathJoin(modsDir, entry.filename))
        } catch {
          // ignore
        }
      }
      delete next[entry.filename]
      next[newFile.filename] = {
        source: 'modrinth',
        sha512: newFile.hashes.sha512,
        versionId: version.id,
        versionNumber: version.version_number,
        projectId: version.project_id,
        datePublished: version.date_published,
      }
      changed = true
    }

    manifest.installedMods = next
    manifest.lastModUpdateCheck = new Date().toISOString()
    await this.writeManifest(manifest)
    if (changed) {
      console.log(`[integrated] mod updates applied`)
    }
  }

  private async ensureEulaAccepted(): Promise<void> {
    const eulaPath = pathJoin(this.serverDir, 'eula.txt')
    let content: string
    try {
      content = await fs.readText(eulaPath)
    } catch {
      content = ''
    }
    if (!content.includes('eula=true')) {
      await fs.writeText(
        eulaPath,
        `#EULA accepted by sandstone-cli at ${new Date().toISOString()}\neula=true\n`,
      )
    }
  }

  /**
   * Compute the JSON `generator-settings` string for the configured
   * world preset. Defaults to a void superflat with a single stone layer
   * at the surface.
   */
  private generatorSettings(): string {
    const w = this.config.world ?? 'void'
    let preset: { layers: Array<{ block: string; height: number }>; biome?: string }
    if (w === 'void') {
      // The Minecraft "The Void" superflat preset. Vanilla MC
      // automatically places a stone spawn platform with a single
      // cobblestone block at the center when it sees a Void-biommed
      // flat world — we don't need to encode the platform in the
      // layers.
      preset = {
        layers: [{ block: 'minecraft:air', height: 1 }],
        biome: 'minecraft:the_void',
      }
    } else if (w === 'overworld') {
      // Standard vanilla overworld.
      preset = {
        layers: [
          { block: 'minecraft:bedrock', height: 1 },
          { block: 'minecraft:dirt', height: 2 },
          { block: 'minecraft:grass_block', height: 1 },
        ],
        biome: 'minecraft:plains',
      }
    } else {
      preset = { layers: w.layers, biome: w.biome ?? 'minecraft:plains' }
    }
    return JSON.stringify(preset)
  }

  /**
   * Write a minimal `server.properties` setting the world generator
   * when `config.world` is provided. With `config.world` unset,
   * Minecraft generates a fresh default overworld — we write nothing.
   *
   * Preserves any existing user-edited fields by reading first and
   * overwriting just the keys we own. The server fills in defaults for
   * any keys we don't set.
   */
  private async writeServerProperties(): Promise<void> {
    if (this.config.world === undefined) return

    const propsPath = pathJoin(this.serverDir, 'server.properties')
    const isFlat = this.config.world !== 'overworld'
    const owned = new Set(['level-type', 'generator-settings', 'level-name', 'level-seed'])

    let lines: string[] = []
    try {
      const existing = await fs.readText(propsPath)
      lines = existing.split('\n')
    } catch {
      // fresh
    }

    // Drop lines we own, then append our values at the end.
    lines = lines.filter((line) => {
      const key = line.split('=', 1)[0]?.trim()
      return !key || !owned.has(key)
    })

    lines.push(`level-type=${isFlat ? 'minecraft:flat' : 'minecraft:normal'}`)
    if (isFlat) {
      lines.push(`generator-settings=${this.generatorSettings()}`)
    }
    lines.push(`level-name=world`)

    await fs.writeText(propsPath, lines.join('\n') + '\n')
  }

  /**
   * Download the latest Fabric installer jar from Fabric's Maven repo,
   * run it with `java -jar installer.jar server -mcversion ...
   * -downloadMinecraft` (no `-loader` — let the installer pick the
   * latest stable for this MC version, which is fully backwards-
   * compatible), then delete the installer. The installer produces
   * `fabric-server-launch.jar` + libraries/ in `serverDir`.
   *
   * Captures the installer's stdout to learn which loader it picked and
   * writes `sandstone_manifest.json` so future `connect()` calls can
   * detect when a newer loader is available and re-install.
   *
   * Version resolution: parses `<latest>` from
   * https://maven.fabricmc.net/net/fabricmc/fabric-installer/maven-metadata.xml.
   */
  private async installFabricServer(latestLoader: string): Promise<void> {
    if (!this.resolvedMinecraftVersion) {
      throw new Error(
        'Minecraft version not resolved — call connect() first',
      )
    }
    if (!this.java) throw new Error('Java not resolved before installer ran')
    const minecraftVersion = this.resolvedMinecraftVersion
    const isSnapshot = this.resolvedMinecraftType === 'snapshot'

    const metadataUrl =
      'https://maven.fabricmc.net/net/fabricmc/fabric-installer/maven-metadata.xml'
    const installerVersion = await fetchLatestVersion(metadataUrl)
    const installerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVersion}/fabric-installer-${installerVersion}.jar`

    const installerPath = pathJoin(this.serverDir, `.fabric-installer-${installerVersion}.jar`)
    await downloadToFile(installerUrl, installerPath)

    let installedLoader: string | null = null
    try {
      const args = [
        '-jar',
        installerPath,
        'server',
        '-mcversion',
        minecraftVersion,
        '-dir',
        this.serverDir,
        '-downloadMinecraft',
      ]
      // Fabric installer's `-snapshot` flag is required for any pre-release
      // / snapshot / RC MC version. Without it, the installer rejects the
      // version string.
      if (isSnapshot) args.push('-snapshot')

      // Pipe stdout so we can scrape "Installing Fabric Loader X.Y.Z(MC)"
      // to record what was actually picked.
      await new Promise<void>((resolve, reject) => {
        const proc = shellSpawn([this.java!.path, ...args], {
          cwd: this.serverDir,
          stdio: ['ignore', 'pipe', 'inherit'],
        })
        let stdoutBuf = ''
        const decoder = new TextDecoder('utf-8')
        void (async () => {
          try {
            const stream = proc.stdout as ReadableStream<Uint8Array<ArrayBufferLike>>
            for await (const chunk of stream) {
              const text = decoder.decode(chunk, { stream: true })
              stdoutBuf += text
              process.stdout.write(text)
            }
          } catch (err) {
            reject(err)
          }
        })()
        proc.exited.then(
          (code) => {
            if (code !== 0) {
              reject(new Error(`Fabric installer exited with code ${code}`))
              return
            }
            // Parse "Installing Fabric Loader X.Y.Z(MC)" — installer prints
            // this once near the top. We need the *picked* version, not the
            // one we requested (we don't pass -loader so this is the
            // installer's own choice).
            const match = stdoutBuf.match(
              /Installing Fabric Loader ([0-9]+\.[0-9]+\.[0-9]+)\(/,
            )
            if (match) installedLoader = match[1]
            resolve()
          },
          reject,
        )
      })

      await this.writeManifest({
        installedFabricLoader: installedLoader ?? latestLoader,
        installerVersion,
        minecraftVersion,
        installedAt: new Date().toISOString(),
      })
    } finally {
      try {
        await fs.deleteFile(installerPath)
      } catch {
        // ignore
      }
    }
  }

  /**
   * Wipe the installer's outputs so the next `installFabricServer` call
   * starts from a clean slate. Used when `sandstone_manifest.json` shows
   * the installed loader is older than the current latest stable.
   */
  private async clearFabricInstall(): Promise<void> {
    const targets = [
      '.fabric',
      'libraries',
      'fabric-server-launch.jar',
      'server.jar',
      'fabric-server-launcher.properties',
    ]
    for (const target of targets) {
      await fs.remove(pathJoin(this.serverDir, target), {
        recursive: true,
        force: true,
      })
    }
  }

  /**
   * Resolve and download the default + user-specified mods into
   * `<serverDir>/mods/`. fabric-api is required and gates the rest of
   * the install — if no fabric-api version exists for the resolved MC
   * version, throws. Other defaults are best-effort (skipped if
   * Modrinth has no matching version).
   *
   * Per-mod toggles default to enabled; set any to `false` in
   * `config.mods` to skip. `fabric-api: false` is rejected up front.
   */
  private async installMods(mcVersion: string): Promise<void> {
    const modsDir = pathJoin(this.serverDir, 'mods')
    await fs.ensureDir(modsDir)
    const cfg = this.config.mods ?? {}
    const enabled = (v: boolean | undefined) => v !== false

    // Track every mod we install so auto-update can find them later.
    // Modrinth-installed mods use the sha512 from the Modrinth version
    // metadata (no extra disk read); URL-installed mods get hashed from
    // disk after download.
    const manifest = await this.readManifest()
    const installedMods: Record<string, InstalledModInfo> = {
      ...(manifest.installedMods ?? {}),
    }
    const trackModrinth = (version: ModrinthVersion, filename?: string): void => {
      const file = primaryFile(version)
      const name = filename ?? file.filename
      installedMods[name] = {
        source: 'modrinth',
        sha512: file.hashes.sha512,
        versionId: version.id,
        versionNumber: version.version_number,
        projectId: version.project_id,
        datePublished: version.date_published,
      }
    }
    const trackUrl = (filename: string, sha512: string): void => {
      installedMods[filename] = { source: 'url', sha512 }
    }

    // Required gate: fabric-api.
    if (!enabled(cfg.fabricApi)) {
      throw new Error(
        'fabric-api is required for the integrated host — do not set mods.fabricApi=false',
      )
    }
    {
      const version = await findModVersion('fabric-api', mcVersion)
      if (!version) {
        throw new Error(
          `fabric-api has no version matching MC ${mcVersion} on Modrinth — cannot start the server without it`,
        )
      }
      await downloadMod(version, pathJoin(modsDir, primaryFileName(version)))
      trackModrinth(version)
    }

    // Best-effort defaults. Each maps config key → Modrinth slug.
    const optionalDefaults: Array<keyof IntegratedHostModsConfig> = [
      'packtest',
      'commandcrafter',
      'worldgenDevtools',
      'quickPack',
      'lithium',
      'ferriteCore',
      'lazyDfu',
      'scalablelux',
    ]
    const slugFor: Record<string, string> = {
      packtest: 'packtest',
      commandcrafter: 'commandcrafter',
      worldgenDevtools: 'worldgen-devtools',
      quickPack: 'quick-pack',
      lithium: 'lithium',
      ferriteCore: 'ferrite-core',
      lazyDfu: 'lazy-dfu',
      scalablelux: 'scalablelux',
    }
    let commandcrafterInstalled = false
    for (const key of optionalDefaults) {
      // Narrow cfg[key] to boolean | undefined — additionalMods is also
      // under cfg with the same key prefix.
      const flag = cfg[key]
      if (typeof flag !== 'boolean' && flag !== undefined) continue
      if (!enabled(flag)) continue
      const slug = slugFor[key as string]
      const version = await findModVersion(slug, mcVersion).catch(() => null)
      if (!version) continue
      const filename = primaryFileName(version)
      await downloadMod(version, pathJoin(modsDir, filename)).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`mod ${slug} download failed: ${err}`)
      })
      trackModrinth(version)
      if (key === 'commandcrafter') commandcrafterInstalled = true
    }

    // commandcrafter pulls fabric-language-kotlin. MC-agnostic — use the
    // project's latest version regardless of game_versions filter.
    if (commandcrafterInstalled) {
      const kotlin = await findModVersion('fabric-language-kotlin')
      if (kotlin) {
        const filename = primaryFileName(kotlin)
        await downloadMod(kotlin, pathJoin(modsDir, filename))
        trackModrinth(kotlin)
      }
    }

    // User-specified extras.
    for (const extra of cfg.additionalMods ?? []) {
      if (extra.modrinthId) {
        const v = await findModVersion(extra.modrinthId, mcVersion)
        if (v) {
          const filename = extra.filename ?? primaryFileName(v)
          await downloadMod(v, pathJoin(modsDir, filename))
          trackModrinth(v, filename)
        }
      } else if (extra.url) {
        const name = extra.filename ?? basenameFromUrl(extra.url)
        await downloadUrl(extra.url, pathJoin(modsDir, name))
        try {
          const sha512 = await this.sha512OfFile(pathJoin(modsDir, name))
          trackUrl(name, sha512)
        } catch {
          // Best-effort — skip tracking if hashing fails.
        }
      }
    }

    manifest.installedMods = installedMods
    // Mark the just-completed install as a recent update check so the
    // auto-update pass on the same connect() doesn't redundantly POST
    // /version_files/update for the files we already pulled latest.
    manifest.lastModUpdateCheck = new Date().toISOString()
    await this.writeManifest(manifest)
  }

  /** Wipe `<serverDir>/mods/` so the next pass re-resolves from Modrinth. */
  private async clearMods(): Promise<void> {
    await fs.remove(pathJoin(this.serverDir, 'mods'), {
      recursive: true,
      force: true,
    })
  }

  }

/** Factory used by the registry. */
export function createIntegratedHost(config: IntegratedHostConfig): HostProvider {
  return new IntegratedHost(config)
}

/**
 * Fetch PrismLauncher's `net.fabricmc.fabric-loader/package.json` and
 * return the first entry of its `recommended` array (the latest stable
 * Fabric Loader for the current MC era). The Fabric installer doesn't
 * pin a default, so we read this to know whether the on-disk install is
 * stale.
 *
 * URL pattern: https://raw.githubusercontent.com/PrismLauncher/meta-launcher/master/net.fabricmc.fabric-loader/package.json
 */
async function fetchLatestFabricLoader(): Promise<string> {
  const url =
    'https://raw.githubusercontent.com/PrismLauncher/meta-launcher/master/net.fabricmc.fabric-loader/package.json'
  // github raw content — route through github.ts so `gh auth` and
  // rate-limit handling kick in automatically.
  const json = JSON.parse(await ghFetchText(url)) as { recommended?: string[] }
  const first = json.recommended?.[0]
  if (!first) {
    throw new Error(`No recommended loader in ${url}`)
  }
  return first
}

/**
 * Compare two semver-ish strings ("0.19.3", "0.16.5"). Returns < 0 if `a`
 * is older, > 0 if `a` is newer, 0 if equal. Doesn't handle pre-release
 * tags — sufficient for Fabric loader versions which use plain `MAJOR.MINOR.PATCH`.
 */
function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPatch] = a.split('.').map(Number)
  const [bMaj, bMin, bPatch] = b.split('.').map(Number)
  if (aMaj !== bMaj) return aMaj - bMaj
  if (aMin !== bMin) return aMin - bMin
  return (aPatch ?? 0) - (bPatch ?? 0)
}

/** Filename of the primary (or first) file in a Modrinth version. */
function primaryFileName(version: ModrinthVersion): string {
  const primary = version.files.find((f) => f.primary)
  return (primary ?? version.files[0]).filename
}

/** Best-effort filename from a download URL's last path segment. */
function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    return last ?? 'mod.jar'
  } catch {
    return 'mod.jar'
  }
}

/**
 * Resolve a Promise that fulfills when a Node `ChildProcess` exits.
 * Mirrors Bun's `proc.exited` API for the spawn-from-`node:child_process`
 * path. If the process has already exited, resolves immediately.
 */
function waitForExit(
  child: import('node:child_process').ChildProcess,
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode)
  }
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code))
  })
}

/**
 * Fetch a Maven `maven-metadata.xml` and return the `<latest>` tag's value,
 * falling back to `<release>` if `<latest>` is absent. Throws on fetch or
 * parse failure.
 */
async function fetchLatestVersion(metadataUrl: string): Promise<string> {
  const resp = await fetch(metadataUrl)
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${metadataUrl}: HTTP ${resp.status}`)
  }
  const xml = await resp.text()
  const latest = xml.match(/<latest>([^<]+)<\/latest>/)?.[1]
  if (latest) return latest
  const release = xml.match(/<release>([^<]+)<\/release>/)?.[1]
  if (release) return release
  throw new Error(`No <latest> or <release> tag in ${metadataUrl}`)
}

/**
 * Stream a URL's response body to a file path, rejecting on non-2xx.
 * Uses Bun's native `Bun.write(dest, response)` which streams from a
 * Response without buffering the full payload into memory.
 */
async function downloadToFile(url: string, dest: string): Promise<void> {
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${resp.status}`)
  }
  await Bun.write(dest, resp)
}