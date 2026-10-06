import { join as pathJoin } from 'path'
import { createHash } from 'crypto'
import { Readable, Writable } from 'stream'
import { ChildProcessWithoutNullStreams, ChildProcess } from 'child_process'

import { NotConnectedError } from '../errors.js'
import { ensureJava, requiredJavaMajor } from '../java.js'
import { RconClient } from '../rcon-client.js'
import {
  downloadMod,
  downloadUrl,
  findLatestVersionsForHashes,
  findModVersion,
  primaryFile,
} from '../modrinth.js'
import { sandstoneToMcVersion } from '../sandstone-version.js'
import * as fs from '../../utils/fs.js'
import { ghFetchText } from '../../utils/github.js'
import { spawn as shellSpawn } from '../../utils/shell.js'
import { Capability, HostProvider } from '../types.js'
import { MINECRAFT_LOG_PREFIX } from '../../commands/run.js'

import type { ModrinthVersion } from '../modrinth.js'
import type { DaemonLogger, HostCapabilities, HostLogLine, HostLogHandler, LogSubscription, IntegratedHostConfig, IntegratedHostModsConfig } from '../types.js'

type ModSource = 'modrinth' | 'url'

interface InstalledModInfo {
  source: ModSource
  sha512: string
  versionId?: string
  versionNumber?: string
  projectId?: string
  datePublished?: string
}

interface SandstoneManifest {
  installedFabricLoader?: string
  installerVersion?: string
  minecraftVersion?: string
  installedAt?: string
  lastModUpdateCheck?: string
  installedMods?: Record<string, InstalledModInfo>
  modsConfigHash?: string
}

const UnwhitelistedAttempt = new RegExp(`${MINECRAFT_LOG_PREFIX}${String.raw`(\w+) \(/([\w\.]+):`}`)

export class IntegratedHost extends HostProvider {
  readonly type = 'integrated' as const
  readonly displayName = 'Integrated Fabric Server'
  readonly capabilities: HostCapabilities = new Set([
    Capability.StartServer,
    Capability.StopServer,
    Capability.ReadFile,
    Capability.WriteFile,
    Capability.AttachLog,
    Capability.ExecuteRawCommand,
    Capability.ExecuteRawCommandHasResponse,
  ])

  private readonly config: IntegratedHostConfig
  private readonly serverDir: string
  private readonly javaDir: string
  private java: Awaited<ReturnType<typeof ensureJava>> | null = null
  private resolvedMinecraftVersion: string | null = null
  private resolvedMinecraftType: 'release' | 'snapshot' | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private rcon: RconClient | null = null
  private connected = false
  private logBuffer: string[] = []
  private partialLine = ''
  private logHandlers = new Set<HostLogHandler>()
  private stderrTail: string[] = []

  private pushStderr(line: string): void {
    this.stderrTail.push(line)
  }

  disconnectHandlers: Set<(reason: string) => void> = new Set<(reason: string) => void>()

  private doneDetected = false
  private rconReadyDetected = false
  private weStarted = false
  public resolveReady: Array<() => void> = []
  private pendingLineMatcher: { pattern: RegExp; resolve: (line: string) => void } | null = null
  private needsInitialWorldSetup = false

  constructor(config: IntegratedHostConfig, logger: DaemonLogger) {
    super(logger)
    this.config = { ...config, world: config.world ?? 'void' }
    this.serverDir =
      config.serverDir ?? pathJoin(config.projectRoot, '.sandstone', 'mc-server')
    this.javaDir = config.javaDir ?? pathJoin(this.serverDir, '.java')
  }


  async connect(): Promise<void> {
    if (this.connected) return
    await fs.ensureDir(pathJoin(this.serverDir, 'debug'))
    // Yeah yeah whatever
    await this.ensureEulaAccepted()
    this.serverPort = await this.resolveServerPort()
    await this.writeServerProperties()

    const { version: mcVersion, type: mcType } = await this.resolveMinecraftVersion()
    this.resolvedMinecraftVersion = mcVersion
    this.resolvedMinecraftType = mcType

    const major = await requiredJavaMajor(mcVersion)
    this.java = await ensureJava(major, this.javaDir)

    const latestLoader = await fetchLatestFabricLoader()
    const manifestPath = pathJoin(this.serverDir, 'sandstone_manifest.json')
    let installedLoader: string | null = null
    let manifestMcVersion: string | null = null
    let manifestModsConfigHash: string | undefined
    try {
      const raw = await fs.readText(manifestPath)
      const manifest = JSON.parse(raw) as {
        installedFabricLoader?: string
        minecraftVersion?: string
        modsConfigHash?: string
      }
      installedLoader = manifest.installedFabricLoader ?? null
      manifestMcVersion = manifest.minecraftVersion ?? null
      manifestModsConfigHash = manifest.modsConfigHash
    } catch {}
    const mcChanged = manifestMcVersion !== null && manifestMcVersion !== mcVersion
    const loaderStale = installedLoader !== null && compareSemver(installedLoader, latestLoader) < 0
    const noManifest = installedLoader === null
    const currentModsConfigHash = hashModsConfig(this.config.mods)
    const modsConfigChanged = manifestModsConfigHash === undefined
      || manifestModsConfigHash !== currentModsConfigHash
    const stale = noManifest || mcChanged || loaderStale || modsConfigChanged
    if (loaderStale || mcChanged || noManifest) {
      if (loaderStale) {
        this.logger.info(
          `test: installed Fabric Loader ${installedLoader} is older than latest ${latestLoader}, re-installing`,
        )
        await this.clearFabricInstall()
      }
      await this.installFabricServer(latestLoader)

      if (mcChanged || noManifest) {
        this.logger.info(
          `[integrated] MC version changed (${manifestMcVersion ?? 'none'} → ${mcVersion}) — re-resolving mods`,
        )
        await this.clearMods()
        await this.installMods(mcVersion)
      }
    } else if (modsConfigChanged) {
      this.logger.info(`[integrated] mods config changed, reconciling...`)
      await this.installMods(mcVersion)
    }
    await this.ensureModsTracked(mcVersion)
    await this.checkModUpdates(mcVersion)

    this.needsInitialWorldSetup = (
      (this.config.world ?? 'void') === 'void'
      && !(await fs.fileExists(pathJoin(this.serverDir, 'world', 'level.dat')))
    )
    this.connected = true
  }

  private async resolveServerPort(): Promise<number> {
    const configured = this.config.serverPort
    if (configured !== undefined && configured > 0) return configured
    const tryBind = async (port: number): Promise<number> => {
      const server = Bun.serve({
        port,
        fetch: () => new Response(),
      })
      const bound = server.port!
      await server.stop()
      return bound
    }
    for (let port = 25565; port < 65535; port++) {
      try {
        return await tryBind(port)
      } catch {}
    }
    throw new Error('No available port found in 25565-65534')
  }

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
      return { version: mc.version, type: mc.type as 'release' | 'snapshot' }
    }
    if (this.config.minecraftVersion) {
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
    if (this.rcon) this.rcon.closeExpected = true

    this.disconnectHandlers.clear()
    this.destroyRcon()
    if (child) {
      const exited = waitForExit(child)
      child.kill('SIGTERM')
      const killer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 120_000)
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

  onDisconnected(handler: (reason: string) => void): () => void {
    this.disconnectHandlers.add(handler)
    return () => {
      this.disconnectHandlers.delete(handler)
    }
  }

  weStartedThisCall(): boolean {
    return this.weStarted
  }

  async startServer(): Promise<void> {
    this.requireConnected('integrated')
    this.weStarted = !this.doneDetected
    if (this.doneDetected) {
      return
    }
    if (this.child) {
      await new Promise<void>((resolve) => this.resolveReady.push(resolve))
      return
    }
    if (!this.java) throw new Error('Java not resolved — connect() failed?')

    const jar = pathJoin(this.serverDir, 'fabric-server-launch.jar')
    if (!(await fs.fileExists(jar))) {
      throw new Error(
        `Fabric server jar not found at ${jar} — run the Fabric installer first`,
      )
    }

    this.logBuffer = []
    this.partialLine = ''
    this.doneDetected = false
    this.rconReadyDetected = false
    this.stderrTail = []
    if (this.rcon) {
      try {
        this.rcon.destroy()
      } catch {}
      this.rcon = null
    }
    const { spawn: nodeSpawn } = await import('node:child_process')
    this.child = nodeSpawn(
      this.java.path,
      ['-jar', 'fabric-server-launch.jar', 'nogui'],
      {
        cwd: this.serverDir,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      },
    )

    const onUnexpectedExit = (code: number | null) => {
      for (const h of this.disconnectHandlers) {
        h(`JVM exited with code ${code}`)
      }
    }
    const onSpawnError = (err: Error) => {
      for (const h of this.disconnectHandlers) {
        h(`JVM spawn error: ${err.message}`)
      }
    }
    this.child.once('exit', onUnexpectedExit)
    this.child.once('error', onSpawnError)

    const decoder = new TextDecoder('utf-8')
    let stderrPartial = ''
    const processChunk = (chunk: Buffer | Uint8Array | string, stream: 'stdout' | 'stderr') => {
      const text =
        typeof chunk === 'string'
          ? chunk
          : decoder.decode(chunk, { stream: true })
      const ts = Date.now()
      const partial = stream === 'stdout' ? this.partialLine : stderrPartial
      const combined = partial + text
      const originalLines = combined.split('\n')
      const leftover = originalLines.pop() ?? ''
      if (stream === 'stdout') this.partialLine = leftover
      else stderrPartial = leftover
      if (originalLines.length === 0) return
      const lines: HostLogLine[] = originalLines.map((line) => ({ line, ts, stream }))
      for (const { line } of lines) {
        if (stream === 'stdout') {
          if (this.logBuffer.length >= 10_000) this.logBuffer.shift()
          this.logBuffer.push(line)
        } else {
          this.pushStderr(line)
        }
        if (line.endsWith('lost connection: You are not white-listed on this server!')) {
          const [_, localPlayer, clientAddress] = UnwhitelistedAttempt.exec(line)!
          if (clientAddress === '127.0.0.1') {
            this.logger.info(`[integrated] local connection attempt with account "${localPlayer}" detected, whitelisting & opping, please rejoin`)
            this.executeRawCommand(`whitelist add ${localPlayer}`).catch(() => {})
            this.executeRawCommand(`op ${localPlayer}`).catch(() => {})
          }
        }
        const matcher = this.pendingLineMatcher
        if (matcher && matcher.pattern.test(line)) {
          this.pendingLineMatcher = null
          matcher.resolve(line)
        }
      }
      for (const handler of this.logHandlers) {
        try {
          handler(lines)
        } catch (err) {
          this.logger.error(`integrated logHandler threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (!this.doneDetected) {
        for (const { line } of lines) {
          if (line.includes('Done (')) {
            this.doneDetected = true
            this.logger.info(
              `[integrated#startServer] detected "Done (" — server is ready`,
            )
            for (const r of this.resolveReady) r()
            this.resolveReady = []
            break
          }
        }
      }
      if (!this.rconReadyDetected && this.config.rcon) {
        const expectedPort = this.config.rcon.port
        for (const { line } of lines) {
          if (
            this.pendingLineMatcher &&
            line.match(this.pendingLineMatcher.pattern) &&
            line.includes(`RCON running on 0.0.0.0:${expectedPort}`)
          ) {
            this.rconReadyDetected = true
            this.logger.info(
              `[integrated#startServer] detected "RCON running on 0.0.0.0:${expectedPort}" — rcon listener ready`,
            )
            const m = this.pendingLineMatcher
            this.pendingLineMatcher = null
            m.resolve(line)
            break
          }
        }
      }
    }

    (async () => {
      try {
        for await (const chunk of this.child!.stdout) {
          processChunk(chunk, 'stdout')
        }
      } catch {}
    })();
    (async () => {
      try {
        for await (const chunk of this.child!.stderr) {
          processChunk(chunk, 'stderr')
        }
      } catch {}
    })()

    const child = this.child
    const donePromise = new Promise<void>((resolve, reject) => {
      this.resolveReady.push(resolve)
      child!.once('exit', (code: number | null) => {
        if (!this.doneDetected) {
          const stdout = this.logBuffer.join('\n').trim()
          const stderr = this.stderrTail.join('\n').trim()
          const sections: string[] = []
          if (stdout) sections.push(`--- stdout ---\n${stdout}`)
          if (stderr) sections.push(`--- stderr ---\n${stderr}`)
          const detail = sections.length > 0 ? `\n${sections.join('\n')}` : ' (no output captured)'
          reject(new Error(`Server exited early with code ${code}${detail}`))
        }
      })
    })

    const rconReadyPromise = this.config.rcon
      ? this.detectLogLine(
          new RegExp(`RCON running on 0\\.0\\.0\\.0:${this.config.rcon.port}`),
        )
      : Promise.resolve()

    await Promise.all([donePromise, rconReadyPromise])

    await this.connectRcon()

    if (this.needsInitialWorldSetup) {
      this.needsInitialWorldSetup = false
      this.logger.info(`[integrated#startServer] running initial world setup (fill + setblock)`)
      const fillSucceeded = this.detectLogLine(/Successfully filled 1089 block\(s\)/)
      await this.executeRawCommand('fill 24 -61 24 -8 -61 -8 stone')
      await fillSucceeded
      const setblockSucceeded = this.detectLogLine(/Changed the block at 8, -61, 8/)
      await this.executeRawCommand('setblock 8 -61 8 cobblestone')
      await setblockSucceeded
    }
  }

  async stopServer(): Promise<void> {
    this.requireConnected('integrated')
    const child = this.child
    this.doneDetected = false
    this.resolveReady = []
    if (!child || child.killed) {
      this.destroyRcon()
      return
    }
    const timeoutMs = (this.config.gracefulStopTimeoutSeconds ?? 30) * 1000
    const exited = waitForExit(child)
    if (this.rcon) this.rcon.closeExpected = true
    let stopSent = false
    if (this.rcon?.isConnected()) {
      const stopPromise = this.rcon.execute('stop').then(
        () => true,
        () => false,
      )
      const result = await Promise.race([stopPromise, exited.then(() => null)])
      if (result === true) stopSent = true
    }
    if (!stopSent) {
      child.stdin?.write('stop\n')
    }
    const killTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGTERM')
        const finalTimer = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 5_000)
        finalTimer.unref?.()
      }
    }, timeoutMs)
    killTimer.unref?.()
    await exited
    clearTimeout(killTimer)
    this.destroyRcon()
    this.child = null
  }

  async readFile(path: string): Promise<Buffer> {
    this.requireConnected('integrated')
    const full = pathJoin(this.serverDir, path)
    return await fs.readBytes(full)
  }

  async readFileStream(path: string): Promise<{ stream: ReadableStream<Uint8Array>; size?: number }> {
    this.requireConnected('integrated')
    const full = pathJoin(this.serverDir, path)
    const { createReadStream, statSync } = await import('node:fs')
    let size: number | undefined
    try {
      size = statSync(full).size
    } catch {}
    const node = createReadStream(full)
    return { stream: Readable.toWeb(node) as ReadableStream<Uint8Array>, size }
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    this.requireConnected('integrated')
    const full = pathJoin(this.serverDir, path)
    await fs.ensureDir(pathJoin(full, '..'))
    await (typeof data === 'string'
      ? fs.writeText(full, data)
      : fs.writeBytes(full, data))
  }

  async writeFileStream(path: string, _opts?: { size?: number }): Promise<WritableStream<Uint8Array>> {
    this.requireConnected('integrated')
    const full = pathJoin(this.serverDir, path)
    await fs.ensureDir(pathJoin(full, '..'))
    const { createWriteStream } = await import('node:fs')
    const node = createWriteStream(full)
    return Writable.toWeb(node) as WritableStream<Uint8Array>
  }

  private detectLogLine(pattern: RegExp): Promise<string> {
    this.logger.info(`[integrated] detectLogLine registered: ${pattern}`)
    for (const line of this.logBuffer) {
      if (pattern.test(line)) {
        this.logger.info(`[integrated] detectLogLine matched in buffer: ${JSON.stringify(line)}`)
        return Promise.resolve(line)
      }
    }
    return new Promise<string>((resolve) => {
      this.pendingLineMatcher = { pattern, resolve }
    })
  }

  async attachLog(onChunk: HostLogHandler): Promise<LogSubscription> {
    this.requireConnected('integrated')
    this.logHandlers.add(onChunk)
    const self = this

    return {
      async unattach() {
        if (!self.logHandlers.has(onChunk)) return
        self.logHandlers.delete(onChunk)
        if (self.partialLine.length > 0) {
          onChunk([{ line: self.partialLine, ts: Date.now(), stream: 'stdout' }])
          self.partialLine = ''
        }
      },
    }
  }

  async executeRawCommand(command: string): Promise<string> {
    this.requireConnected('integrated')
    if (!this.rcon || !this.rcon.isConnected()) {
      throw new Error('Server is not running (rcon not connected)')
    }
    return await this.rcon.execute(command)
  }

  private async connectRcon(): Promise<void> {
    const rconCfg = this.config.rcon
    if (!rconCfg) return
    if (rconCfg.enabled === false || !rconCfg.port || !rconCfg.password) return
    const rcon = new RconClient({
      host: '127.0.0.1',
      port: rconCfg.port,
      password: rconCfg.password,
    })
    try {
      await rcon.authenticate()
      this.rcon = rcon
      this.capabilities.add(Capability.ExecuteRawCommand)
      this.capabilities.add(Capability.ExecuteRawCommandHasResponse)
      rcon.installLivenessHandlers({
        onClose: () => {
          for (const h of this.disconnectHandlers) h('RCON connection closed')
        },
        onError: (err) => {
          for (const h of this.disconnectHandlers) h(`RCON socket error: ${err.message}`)
        },
      })
    } catch (err) {
      this.rcon = null
      this.logger.error(
        `[integrated] RCON authenticate failed (${err instanceof Error ? err.message : String(err)}) — executeRawCommand disabled`,
      )
    }
  }

  private destroyRcon(): void {
    this.rcon?.destroy()
    this.rcon = null
  }

  // ---------------------------------------------------------------------

  private requireConnected(label: string): void {
    if (!this.connected) throw new NotConnectedError(label)
  }

  private async readManifest() {
    const manifestPath = pathJoin(this.serverDir, 'sandstone_manifest.json')
    try {
      const raw = await fs.readText(manifestPath)
      return JSON.parse(raw) as SandstoneManifest
    } catch {
      return {}
    }
  }

  private async writeManifest(manifest: SandstoneManifest) {
    await fs.writeText(
      pathJoin(this.serverDir, 'sandstone_manifest.json'),
      JSON.stringify(manifest, null, 2),
    )
  }

  private async sha512OfFile(absPath: string): Promise<string> {
    const bytes = await fs.readBytes(absPath)
    return createHash('sha512').update(bytes).digest('hex')
  }

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
      } catch {}
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
      this.logger.warn(`mod tracking bootstrap failed: ${err}`)
    }

    for (const { filename, sha512 } of entries) {
      installedMods[filename] = modrinthHashes.has(sha512)
        ? { source: 'modrinth', sha512 }
        : { source: 'url', sha512 }
    }

    manifest.installedMods = installedMods
    delete manifest.lastModUpdateCheck
    await this.writeManifest(manifest)
  }

  private async checkModUpdates(mcVersion: string): Promise<void> {
    const manifest = await this.readManifest()
    const hasMods =
      !!manifest.installedMods && Object.keys(manifest.installedMods).length > 0
    if (manifest.lastModUpdateCheck && hasMods) {
      const elapsed = Date.now() - new Date(manifest.lastModUpdateCheck).getTime()
      if (elapsed < 60 * 60 * 1000) return
    }

    const installedMods = manifest.installedMods ?? {}
    const tracked = Object.entries(installedMods).filter(
      ([, info]) => info.source === 'modrinth' && info.sha512,
    )
    if (tracked.length === 0) {
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
      this.logger.warn(`mod update check failed: ${err}`)
      return
    }

    const modsDir = pathJoin(this.serverDir, 'mods')
    let changed = false
    const next: Record<string, InstalledModInfo> = { ...installedMods }
    for (const [sha, version] of updates) {
      const entry = hashToEntry.get(sha)
      if (!entry) continue
      const newFile = primaryFile(version)
      if (newFile.hashes.sha512 === sha) continue
      this.logger.info(
        `[integrated] mod update: ${entry.filename} ${entry.info.versionNumber ?? '?'} → ${version.version_number}`,
      )
      await downloadMod(version, pathJoin(modsDir, newFile.filename))
      if (newFile.filename !== entry.filename) {
        try {
          await fs.remove(pathJoin(modsDir, entry.filename))
        } catch {}
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
      this.logger.info(`[integrated] mod updates applied`)
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

  public serverPort: number | null = null

  private generatorSettings(): string {
    const w = this.config.world ?? 'void'
    let preset: { layers: Array<{ block: string; height: number }>; biome?: string }
    if (w === 'void') {
      preset = {
        layers: [{ block: 'minecraft:air', height: 1 }],
        biome: 'minecraft:the_void',
      }
    } else if (w === 'overworld') {
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

  private async writeServerProperties(): Promise<void> {
    if (this.serverPort === null && this.config.rcon?.enabled !== true && this.config.world === undefined) {
      return
    }

    const propsPath = pathJoin(this.serverDir, 'server.properties')
    const isFlat = this.config.world !== 'overworld'
    const owned = new Set([
      // World generator
      'level-type',
      'generator-settings',
      'level-name',
      'level-seed',
      'generate-structures',
      // Network
      'server-port',
      // RCON
      'enable-rcon',
      'rcon.port',
      'rcon.password',
      // Defaults we always apply
      'gamemode',
      'allow-flight',
      'spawn-protection',
      'view-distance',
      'function-permission-level',
      'pause-when-empty-seconds',
      'motd',
    ])

    let lines: string[] = []
    try {
      const existing = await fs.readText(propsPath)
      lines = existing.split('\n')
    } catch {}

    lines = lines.filter((line) => {
      const key = line.split('=', 1)[0]?.trim()
      return !key || !owned.has(key)
    })

    if (this.config.world !== 'overworld') {
      const worldName = this.config.world ?? 'void'
      lines.push(`level-type=${isFlat ? 'minecraft:flat' : 'minecraft:normal'}`)
      if (isFlat) {
        lines.push(`generator-settings=${this.generatorSettings()}`)
      }
      lines.push(`level-name=world`)
      if (worldName === 'void') {
        lines.push('generate-structures=false')
      }
    }
    if (this.serverPort !== null) {
      lines.push(`server-port=${this.serverPort}`)
    }
    const rcon = this.config.rcon
    if (rcon?.enabled === true) {
      lines.push(`enable-rcon=true`)
      lines.push(`rcon.port=${rcon.port ?? 25575}`)
      lines.push(`rcon.password=${rcon.password ?? ''}`)
    }

    lines.push('gamemode=creative')
    lines.push('allow-flight=true')
    lines.push('spawn-protection=0')
    lines.push('view-distance=20')
    lines.push('function-permission-level=4')
    lines.push('pause-when-empty-seconds=0')

    const motd = this.config.sandstoneConfig?.name
      ? `Integrated ${this.config.sandstoneConfig.name} Sandstone Server`
      : 'Integrated Sandstone Server'
    lines.push(`motd=${motd}`)

    await fs.writeText(propsPath, lines.join('\n') + '\n')
  }

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
    const installerUrl = 
      `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVersion}/fabric-installer-${installerVersion}.jar`

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
      if (isSnapshot) args.push('-snapshot')

      await new Promise<void>((resolve, reject) => {
        this.logger.info('[integrated] running fabric server installer...')
        const proc = shellSpawn([this.java!.path, ...args], {
          cwd: this.serverDir,
          stdio: ['ignore', 'pipe', 'inherit'],
        })
        let stdoutBuf = ''
        const decoder = new TextDecoder('utf-8')
        ;(async () => {
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
      } catch {}
    }
  }

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

  private async installMods(mcVersion: string): Promise<void> {
    const modsDir = pathJoin(this.serverDir, 'mods')
    await fs.ensureDir(modsDir)
    const cfg = this.config.mods ?? {}
    const enabled = (v: boolean | undefined) => v !== false

    const manifest = await this.readManifest()
    const installedMods: Record<string, InstalledModInfo> = {
      ...(manifest.installedMods ?? {}),
    }
    const isTracked = (filename: string, sha512: string): boolean => {
      return installedMods[filename]?.sha512 === sha512
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
      const file = primaryFile(version)
      const filename = primaryFileName(version)
      if (!isTracked(filename, file.hashes.sha512)) {
        await downloadMod(version, pathJoin(modsDir, filename))
      }
      trackModrinth(version)
    }

    const optionalDefaults: Array<keyof IntegratedHostModsConfig> = [
      'packtest',
      'commandcrafter',
      'worldgenDevtools',
      'quickPack',
      'lithium',
      'krypton',
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
      krypton: 'krypton',
      ferriteCore: 'ferrite-core',
      lazyDfu: 'lazy-dfu',
      scalablelux: 'scalablelux',
    }
    let commandcrafterInstalled = false
    const unavailable: string[] = []
    for (const key of optionalDefaults) {
      const flag = cfg[key]
      if (typeof flag !== 'boolean' && flag !== undefined) continue
      if (!enabled(flag)) continue
      const slug = slugFor[key as string]
      const version = await findModVersion(slug, mcVersion).catch(() => null)
      if (!version) {
        unavailable.push(slug)
        continue
      }
      const file = primaryFile(version)
      const filename = primaryFileName(version)
      if (!isTracked(filename, file.hashes.sha512)) {
        await downloadMod(version, pathJoin(modsDir, filename)).catch((err) => {
          this.logger.error(`[integrated] mod ${slug} download failed: ${err}`)
        })
      }
      trackModrinth(version)
      if (key === 'commandcrafter') commandcrafterInstalled = true
    }
    if (unavailable.length > 0) {
      this.logger.error(`[integrated] mods with no version for MC ${mcVersion}: ${unavailable.join(', ')}`)
    }
    if (commandcrafterInstalled) {
      const kotlin = await findModVersion('fabric-language-kotlin')
      if (kotlin) {
        const file = primaryFile(kotlin)
        const filename = primaryFileName(kotlin)
        if (!isTracked(filename, file.hashes.sha512)) {
          await downloadMod(kotlin, pathJoin(modsDir, filename))
        }
        trackModrinth(kotlin)
      }
    }
    for (const extra of cfg.additionalMods ?? []) {
      if (extra.modrinthId) {
        const v = await findModVersion(extra.modrinthId, mcVersion)
        if (v) {
          const file = primaryFile(v)
          const filename = extra.filename ?? file.filename
          if (!isTracked(filename, file.hashes.sha512)) {
            await downloadMod(v, pathJoin(modsDir, filename))
          }
          trackModrinth(v, filename)
        }
      } else if (extra.url) {
        const name = extra.filename ?? basenameFromUrl(extra.url)
        const filePath = pathJoin(modsDir, name)
        const existingSha = installedMods[name]?.sha512
        if (existingSha === undefined || !(await fs.fileExists(filePath))) {
          await downloadUrl(extra.url, filePath)
          try {
            const sha512 = await this.sha512OfFile(filePath)
            trackUrl(name, sha512)
          } catch {}
        }
      }
    }

    manifest.installedMods = installedMods
    manifest.modsConfigHash = hashModsConfig(this.config.mods)
    manifest.lastModUpdateCheck = new Date().toISOString()
    await this.writeManifest(manifest)
  }

  private async clearMods(): Promise<void> {
    await fs.remove(pathJoin(this.serverDir, 'mods'), {
      recursive: true,
      force: true,
    })
  }
}

export function createIntegratedHost(config: IntegratedHostConfig, logger: DaemonLogger): HostProvider {
  return new IntegratedHost(config, logger)
}

async function fetchLatestFabricLoader(): Promise<string> {
  const url =
    'https://raw.githubusercontent.com/PrismLauncher/meta-launcher/master/net.fabricmc.fabric-loader/package.json'
  const json = JSON.parse(await ghFetchText(url)) as { recommended?: string[] }
  const first = json.recommended?.[0]
  if (!first) {
    throw new Error(`No recommended loader in ${url}`)
  }
  return first
}

function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPatch] = a.split('.').map(Number)
  const [bMaj, bMin, bPatch] = b.split('.').map(Number)
  if (aMaj !== bMaj) return aMaj - bMaj
  if (aMin !== bMin) return aMin - bMin
  return (aPatch ?? 0) - (bPatch ?? 0)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

function hashModsConfig(mods: IntegratedHostModsConfig | undefined): string {
  return createHash('sha256').update(stableStringify(mods ?? {})).digest('hex')
}

function primaryFileName(version: ModrinthVersion): string {
  const primary = version.files.find((f) => f.primary)
  return (primary ?? version.files[0]).filename
}

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    return last ?? 'mod.jar'
  } catch {
    return 'mod.jar'
  }
}

function waitForExit(
  child: ChildProcess,
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode)
  }
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code))
  })
}

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

async function downloadToFile(url: string, dest: string): Promise<void> {
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${resp.status}`)
  }
  await Bun.write(dest, resp)
}