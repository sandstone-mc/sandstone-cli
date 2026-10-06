import ParcelWatcher, { subscribe, type Event } from '@parcel/watcher'
import { watchFile, unwatchFile } from 'node:fs'
import { realpath } from 'fs/promises'
import React from 'react'
import { render } from 'ink'
import path, { join, relative, resolve } from 'path'
import { pathToFileURL } from 'url'

import { normalizePath } from '../utils/index.js'
import { loadSandstoneConfig } from '../utils/sandstoneConfig.js'
import { _buildCommand, type BuildOptions } from './build/index.js'
import type { BuildResult } from '../ui/types.js'
import { repackIfLinked } from './link.js'
import { WatchUI, getWatchUIAPI } from '../ui/WatchUI.js'
import { logger, type LoggerSink } from '../utils/logger.js'
import type { TrackedChange, ChangeCategory } from '../ui/types.js'
import * as fs from '../utils/fs.js'
import { run, spawn } from '../utils/shell.js'
import { Client as DaemonClient } from './connect/client.js'
import { endpointStatus, readEndpoint } from './connect/endpoint-file.js'
import { prepareConnectSink, resolveHostAndConfig, startInProcessDaemon } from './connect/daemon-setup.js'
import { Daemon, type DaemonHandle } from './connect/daemon.js'
import { deployDatapack, checkDeployState } from './deploy.js'
import { stripCliFrames } from '../utils/strip-cli-frames.js'
import chalk from 'chalk-template'
import { runTests, renderTestEvent, type TestEvent, type TestEventSink } from './test.js'
import type { WorkerResponse, WorkerRequest } from './build/worker-types.js'
import type { SandstoneConfig } from 'sandstone'
import { Capability, type HostType } from '../hosts/types.js'
import { IntegratedHost } from 'src/hosts/providers/integrated.js';

const MinecraftTimestampRegex = /^\[\d{2}:\d{2}:\d{2}\] /

export interface WatchOptions extends BuildOptions {
  manual?: boolean
  library?: boolean
  ignore?: string[]
  daemon?: boolean
  hostType?: HostType
}

type DaemonSurface = DaemonClient | Daemon

export async function watchCommand(opts: WatchOptions) {
  let alreadyBuilding = false
  let needRebuild = false
  let pendingChanges: TrackedChange[] = []
  let lastBuildFailed = false
  let buildRequestSeq = 0
  let currentBuildWorker: Worker | null = null
  const workerInflight = new Map<number, { resolve: (r: BuildResult) => void; reject: (e: Error) => void; cleanup: () => void; request: WorkerRequest }>()

  // Read the user's `sandstone.config.ts` so `connect.watcherAuto` /
  // `connect.host` can fill in for missing CLI flags. CLI flag wins —
  // a flag that's been explicitly set (even to `false`) means "I know
  // what I'm doing, don't second-guess me." Loading the config is
  // best-effort: a missing or broken file just leaves the fallbacks
  // empty.
  const sandstoneCfg = await loadSandstoneConfig(opts.path)
  if (opts.daemon === undefined && sandstoneCfg?.connect?.watcherAuto) {
    opts.daemon = true
  }
  const connectHost = sandstoneCfg?.connect?.host

  const folder = opts.library ? join(opts.path, 'test') : opts.path

  let daemonClient: DaemonClient | undefined
  let daemonHandle: DaemonHandle | undefined = undefined
  let bootstrapInFlight: Promise<DaemonHandle> | undefined = undefined
  let skipNextReload = false
  let surface: DaemonSurface | undefined
  let daemonPoll: ReturnType<typeof setInterval> | undefined
  let linkVersionWatchers: { file: string }[] = []
  let sigintHandler: (() => Promise<void>) | undefined

  let subscription: Awaited<ReturnType<typeof subscribe>>

  // Process-wide logger. Sinks are registered as the watcher boots:
  // 'watch' is the first, 'connect' joins when the daemon comes up,
  // 'test' joins for the duration of a test run. Local aliases for
  // the per-sink log methods keep the call sites readable.
  logger.registerSink('watch', join(opts.path, '.sandstone', 'watch.log'), 'Watch')
  logger.sinks.watch.setLiveCallback((level, args) => {
    getWatchUIAPI()?.setLiveLog(level, args)
  })
  const { log, logInfo, logWarn, logError, logDebug, logTrace } = logger.sinks.watch

  let unmountInk: (() => void) | undefined

  function ensureBuildWorker() {
    if (currentBuildWorker) return currentBuildWorker
    const url = pathToFileURL(path.join(folder, 'node_modules', 'sandstone-cli', 'lib', 'build-worker.js'))
    const worker = new Worker(url, { env: { ...process.env, SAND_WORKER: '1' } })
    currentBuildWorker = worker
    worker.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data as WorkerResponse
      if ('__log' in msg) {
        const { level, line } = msg.__log
        if (level === 'log') log(line)
        else if (level === 'info') logInfo(line)
        else if (level === 'warn') logWarn(line)
        else if (level === 'error') logError(line)
        else if (level === 'trace') logTrace(line)
        else logDebug(line)
        return
      }
      if (!('id' in msg)) return
      const id = msg.id
      const slot = workerInflight.get(id)
      if ('__needsRestart' in msg) {
        if (currentBuildWorker === worker) currentBuildWorker = null
        try { void worker.terminate() } catch (_) {}
        if (slot) {
          const retry = { ...slot.request, lastBuildFailed: false }
          workerInflight.delete(id)
          const freshWorker = ensureBuildWorker()
          workerInflight.set(id, { ...slot, request: retry })
          freshWorker.postMessage(retry)
        }
        return
      }
      if (!slot) return
      workerInflight.delete(id)
      slot.cleanup()
      if ('__error' in (msg as object)) {
        slot.reject(new Error((msg as unknown as { __error: string }).__error))
      } else if ('ok' in (msg as object)) {
        slot.resolve((msg as unknown as { result: BuildResult }).result)
      }
    })
    worker.addEventListener('error', (err: ErrorEvent) => {
      const text = err.message || 'worker error (no message)'
      const m = text.match(/^error:\\s*(.+)$/m)
      const reason = m ? m[1].trim() : text.trim()
      const err2 = new Error('build worker crashed: ' + reason)
      for (const [, slot] of workerInflight) {
        workerInflight.delete(slot as unknown as number)
        ;(slot as unknown as { reject: (e: Error) => void; resolve: (r: BuildResult) => void }).reject(err2)
      }
    })
    return worker
  }

  async function runBuild(opts: BuildOptions, folder: string, watching: boolean): Promise<BuildResult> {
    const worker = ensureBuildWorker()
    const id = ++buildRequestSeq
    const resolvedFolder = normalizePath(await realpath(folder))
    const resolvedRoot = normalizePath(await realpath(opts.path))
    const request: WorkerRequest = {
      id,
      entryPath: pathToFileURL(process.argv[1]!).href,
      optsJson: JSON.stringify(opts),
      folder,
      watching,
      resolvedFolder,
      resolvedRoot,
      lastBuildFailed,
    }
    return await new Promise<BuildResult>((resolve, reject) => {
      workerInflight.set(id, { resolve, reject, cleanup: () => {}, request })
      worker.postMessage(request)
    })
  }

  const handleManualRebuild = () => {
    if (pendingChanges.length > 0 && !alreadyBuilding) {
      daemonLog('Manual rebuild triggered')
      onFilesChange(pendingChanges)
      pendingChanges = []
    }
  }

  const handleDeploy = async () => {
    if (!surface) {
      daemonLog(chalk`{blue [watch]} no sand connect daemon running — start one with \`sand connect\` to enable deploy`)
      return
    }
    try {
      const result = await deployDatapack({ daemon: surface, projectRoot: opts.path })
      daemonLog(chalk`{blue [watch]} deployed ${result.archiveName} -> ${result.remotePath} (${result.bytesWritten} bytes)`)
      for (const dep of result.dependencies) {
        daemonLog(chalk`{blue [watch]}   dep ${dep.name} -> ${result.remotePath} (${dep.bytesWritten} bytes)`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      daemonLog(chalk`{blue [watch]} deploy failed: ${message}`)
    }
    void refreshDeployHasChanges()
  }

  const refreshDeployHasChanges = async () => {
    if (!deployAvailable) {
      getWatchUIAPI()?.setDeployHasChanges(false)
      return
    }
    try {
      const state = await checkDeployState({ projectRoot: opts.path })
      const hasChanges =
        (state.main !== undefined && !state.main.unchanged) ||
        state.folderDeps.some((d) => !d.unchanged) ||
        state.zipDeps.some((d) => !d.unchanged)
      getWatchUIAPI()?.setDeployHasChanges(hasChanges)
    } catch {
      getWatchUIAPI()?.setDeployHasChanges(false)
    }
  }

  let cancelBuildTimer: ReturnType<typeof setTimeout> | null = null
  const clearCancelBuildTimer = () => {
    if (cancelBuildTimer) {
      clearTimeout(cancelBuildTimer)
      cancelBuildTimer = null
    }
    getWatchUIAPI()?.setCanCancelBuild(false)
  }

  const handleCancelBuild = () => {
    if (!alreadyBuilding) return
    daemonLog('Build cancelled via TUI')
    if (currentBuildWorker) {
      void currentBuildWorker.terminate()
      currentBuildWorker = null
    }
    const cancelled = new Error('Build cancelled by user')
    for (const [id, slot] of workerInflight) {
      workerInflight.delete(id)
      slot.reject(cancelled)
    }
    clearCancelBuildTimer()
    alreadyBuilding = false
    needRebuild = false
    pendingChanges = []
    getWatchUIAPI()?.setStatus('watching')
    if (surface) {
      void surface.publishRebuild({
        state: 'failed',
        fileCount: 0,
        errorCount: 1,
        warningCount: 0,
        at: new Date().toISOString(),
        message: 'Cancelled by client',
      }).catch(() => {})
    }
  }
  let testingMode = false
  let alreadyTesting = false
  let currentHasTests = false
  let testCancelTimer: ReturnType<typeof setTimeout> | null = null
  let testAbortController: AbortController | null = null
  let suppressHostLog = false
  const testEvents: TestEvent[] = []
  let testPassCount = 0
  let testFailCount = 0

  const syncTestsBindings = () => {
    const api = getWatchUIAPI()
    if (!api) return
    api.setCanToggleTests(currentHasTests && !alreadyBuilding && !alreadyTesting)
    api.setTestingMode(testingMode)
  }

  const clearTestCancelTimer = () => {
    if (testCancelTimer) {
      clearTimeout(testCancelTimer)
      testCancelTimer = null
    }
    getWatchUIAPI()?.setCanCancelTest(false)
  }

  const runTestSession = async () => {
    if (alreadyTesting) return
    if (!daemonClient) return
    const dc = daemonClient
    alreadyTesting = true
    suppressHostLog = true
    testEvents.length = 0
    testPassCount = 0
    testFailCount = 0
    testAbortController = new AbortController()
    syncTestsBindings()
    getWatchUIAPI()?.setStatus('building')

    const sessionStartedAt = Date.now()
    dc.publishTestComplete({
      state: 'started',
      pass: 0,
      fail: 0,
      durationSec: 0,
      at: new Date(sessionStartedAt).toISOString(),
    }).catch(() => {})

    testCancelTimer = setTimeout(() => {
      testCancelTimer = null
      if (alreadyTesting) getWatchUIAPI()?.setCanCancelTest(true)
    }, 10_000)

    // Mirror `sand test`'s `.sandstone/test.log` from the watcher, and
    // feed the daemon's test log buffer so `sandstone://test-log`
    // reflects this run. The `test` sink is registered alongside
    // `watch` and `connect` for the duration of the test run; the
    // `test` and `connect` sinks are closed explicitly in the
    // `finally` block so they don't accumulate across runs.
    try {
      logger.registerSink('test', join(opts.path, '.sandstone', 'test.log'), 'Watch test session')
    } catch (err) {
      logWarn(`[watch] could not open test log: ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      const exitCode = await runTests(
        { path: opts.path },
        testAbortController.signal,
        ((e: TestEvent) => {
          testEvents.push(e)
          if (e.event === 'test_result') {
            if (e.passed) testPassCount++
            else testFailCount++
          } else if (e.event === 'summary') {
            testPassCount = e.pass
            testFailCount = e.fail
          }
          const lines = renderTestEvent(e)
          for (const line of lines) log(line)
          // Mirror to .sandstone/test.log and daemon test buffer.
          if (lines.length > 0) {
            for (const line of lines) log(line)
            void dc.publishLog({
              target: 'test',
              entries: lines.map((line) => ({ line, ts: Date.now(), stream: 'stdout' })),
            }).catch(() => {})
          }
        }) satisfies TestEventSink,
        dc,
      )
      const durationSec = Math.max(0, Math.round((Date.now() - sessionStartedAt) / 1000))
      daemonLog(exitCode === 0 ? chalk`{green Tests finished (exit ${exitCode})}` : chalk`{red Tests finished (exit ${exitCode})}`)
      const state = exitCode === 0 ? 'complete' : exitCode === 130 ? 'cancelled' : 'failed'
      dc.publishTestComplete({
        state,
        pass: testPassCount,
        fail: testFailCount,
        durationSec,
        at: new Date().toISOString(),
        ...(exitCode !== 0 ? { message: `Tests exited with code ${exitCode}` } : {}),
      }).catch(() => {})
    } finally {
      clearTestCancelTimer()
      testAbortController = null
      alreadyTesting = false
      suppressHostLog = false
      getWatchUIAPI()?.setStatus('watching')
      syncTestsBindings()
      if (needRebuild) {
        needRebuild = false
        const nextChanges = [...pendingChanges]
        pendingChanges = []
        onFilesChange(nextChanges)
      }
    }
  }

  const setTestingMode = (target: boolean) => {
    if (alreadyBuilding || alreadyTesting) return
    if (testingMode === target) return
    const entering = target
    testingMode = target
    syncTestsBindings()
    daemonLog(`Tests mode ${testingMode ? 'on' : 'off'}`)
    if (entering) onFilesChange([])
  }

  const handleToggleTests = () => setTestingMode(!testingMode)

  const handleCancelTest = () => {
    if (!alreadyTesting) return
    daemonLog('Test cancelled via TUI')
    testAbortController?.abort()
    if (surface) {
      void surface.publishTestComplete({
        state: 'cancelled',
        pass: testPassCount,
        fail: testFailCount,
        durationSec: 0,
        at: new Date().toISOString(),
        message: 'Cancelled by client',
      }).catch(() => {})
    }
  }

  let shuttingDown = { flag: false }
  let weSpawnedIntegrated = false

  const { unmount } = render(
    React.createElement(WatchUI, {
      manual: opts.manual ?? false,
      onManualRebuild: handleManualRebuild,
      onDeploy: handleDeploy,
      onCancelBuild: handleCancelBuild,
      onToggleTests: handleToggleTests,
      onCancelTest: handleCancelTest,
      cwd: opts.path,
      exit: () => exit(subscription, currentBuildWorker, shuttingDown, weSpawnedIntegrated, log, unmountInk, sigintHandler, linkVersionWatchers, daemonPoll, daemonClient, daemonHandle),
      onRunUpdates: async (commands) => {
        await cleanup(subscription, currentBuildWorker, shuttingDown, weSpawnedIntegrated, log, unmountInk, sigintHandler, linkVersionWatchers, daemonPoll, daemonClient, daemonHandle)
        for (const cmd of commands) {
          try {
            console.log(`$ ${cmd}`)
            await run(
              process.platform === 'win32' ? 'cmd' : 'sh',
              [process.platform === 'win32' ? '/c' : '-c', cmd],
              { stdio: 'inherit', throws: false }
            )
          } catch (err) {
            console.error(`Update command failed: ${cmd}\n${(err as Error).message ?? err}`)
          }
        }
        process.exit(0)
      },
    }),
    { patchConsole: false, exitOnCtrlC: false }
  )
  unmountInk = unmount

  async function onFilesChange(changes: TrackedChange[]) {
    if (alreadyBuilding) {
      needRebuild = true
      for (const change of changes) {
        if (!pendingChanges.some(c => c.path === change.path)) {
          pendingChanges.push(change)
        }
      }
      return
    }
    if (alreadyTesting) {
      needRebuild = true
      for (const change of changes) {
        if (!pendingChanges.some(c => c.path === change.path)) {
          pendingChanges.push(change)
        }
      }
      return
    }
    alreadyBuilding = true
    syncTestsBindings()
    cancelBuildTimer = setTimeout(() => {
      cancelBuildTimer = null
      if (alreadyBuilding) getWatchUIAPI()?.setCanCancelBuild(true)
    }, 10_000)

    const api = getWatchUIAPI()

    try {
      api?.setStatus('building')
      api?.setChangedFiles(changes)
      daemonLog(`Building... ${changes.map(c => './' + relative(opts.path, c.path).replace(/\\/g, '/')).join(', ')}`)

      const packageJSON = JSON.parse(await fs.readText(join(folder, 'package.json')))

      const libChanges = changes.filter((change) => !change.path.includes('test/'))

      const libFolder = join(opts.path, 'lib')

      if (
        (!opts.library && (
          !packageJSON['module']?.endsWith('.ts')
          || !(await fs.fileExists(join(opts.path, 'sandstone.config.ts')))
        ))
      ) {
        if (api !== undefined && api.exit !== undefined) {
          api.exit()
        }
        throw new Error('Not a Sandstone project! Did you mean to run `sand watch --library`?')
      }

      if (
        opts.library && (
          libChanges.length !== 0 ||
          !(await fs.pathExists(libFolder)) ||
          !(await fs.pathExists(join(libFolder, 'index.js'))) ||
          !(await fs.pathExists(join(libFolder, 'index.d.ts')))
        )
      ) {
        const CLI = spawn(['bun', 'dev:build'], {
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdout: 'ignore',
          stderr: 'ignore',
        })

        await CLI.exited

        await repackIfLinked(opts.path)
      }
      opts.test = testingMode
      const result = await runBuild(opts, folder, true)
      const displayResult: BuildResult = result.success
        ? result
        : { ...result, error: result.error ? stripCliFrames(result.error) : result.error }

      if (result.success && result.sandstoneConfig !== undefined) {
        lastBuildSaveConfig = result.activeSaveConfig
        lastBuildConfigPath = resolve(folder, 'sandstone.config.ts')
        void refreshDeployHasChanges()
      }

      api?.setBuildResult(displayResult)

      if (surface) {
        const state = result.success ? 'complete' : 'failed'
        void surface.publishRebuild({
          state,
          fileCount: result.resourceCounts.functions + result.resourceCounts.other,
          errorCount: result.success ? 0 : 1,
          warningCount: 0,
          at: new Date().toISOString(),
          testingMode,
          ...(result.success ? {} : result.error ? { message: result.error.slice(0, 500) } : {}),
        }).catch(() => {})
      }

      if (result.success) {
        daemonLog(`Build successful: ${result.resourceCounts.functions} functions, ${result.resourceCounts.other} others`)
        lastBuildFailed = false
        currentHasTests = result.hasTests === true
        syncTestsBindings()
        if (surface) {
          if (skipNextReload) {
            skipNextReload = false
            if (testingMode) void runTestSession()
          } else {
            daemonLog('Sent /reload to host daemon')
            surface.reloadResources()
              .then(() => {
                if (testingMode) void runTestSession()
              })
              .catch((err) => {
                logWarn(`[watch] daemon reload failed: ${err instanceof Error ? err.message : String(err)}`)
              })
          }
        }
      } else {
        logError(displayResult.error || '')
        lastBuildFailed = true
      }

      if (needRebuild) {
        needRebuild = false
        const nextChanges = [...pendingChanges]
        pendingChanges = []
        await onFilesChange(nextChanges)
      }
    } finally {
      alreadyBuilding = false
      clearCancelBuildTimer()
      syncTestsBindings()
    }
  }

  let restartTimeout: ReturnType<typeof setTimeout> | null = null
  let debouncedChanges: TrackedChange[] = []
  let debounceScheduled = false

  function restart() {
    daemonLog('Restarting watch process...')
    getWatchUIAPI()?.setStatus('restarting')

    const [runtime, ...args] = process.argv
    const child = spawn([runtime, ...args], {
      stdio: ['inherit', 'inherit', 'inherit'],
      detached: true,
    })
    child.unref()

    unmountInk?.()
    process.exit(0)
  }

  const handleEvents = (events: Event[]) => {
    let needsRestart = false
    const trackedChanges: TrackedChange[] = []

    for (const e of events) {
      const eventPath = normalizePath(e.path)

      const lockFile =
        eventPath.endsWith('.lock') ||
        eventPath.endsWith('-lock.yml') ||
        eventPath.endsWith('-lock.json')

      if (
        lockFile ||
        eventPath.includes('node_modules/') ||
        eventPath.endsWith('sandstone.config.ts')
      ) {
        needsRestart = true
      }

      const inSrc = eventPath.includes('src/')
      const inResources = eventPath.includes('resources/')
      const endsJs = eventPath.endsWith('.js')
      const endsJson = eventPath.endsWith('.json')
      const endsTs = eventPath.endsWith('.ts') && !eventPath.endsWith('.test.ts')

      if (inSrc || inResources || endsJs || endsJson || endsTs) {
        trackedChanges.push({
          path: eventPath,
          category: categorizeChange(eventPath),
        })
      }
    }

    if (trackedChanges.length === 0 && !needsRestart) {
      return
    }

    if (needsRestart) {
      if (restartTimeout) {
        clearTimeout(restartTimeout)
      }
      restartTimeout = setTimeout(restart, 500)
      return
    }

    for (const change of trackedChanges) {
      if (!debouncedChanges.some(c => c.path === change.path)) {
        debouncedChanges.push(change)
      }
    }

    if (debounceScheduled) return

    debounceScheduled = true

    setTimeout(() => {
      debounceScheduled = false

      const changesToProcess = [...debouncedChanges]
      debouncedChanges = []

      if (changesToProcess.length === 0) {
        return
      }

      if (opts.manual) {
        const existingPaths = new Set(pendingChanges.map(c => c.path))
        for (const change of changesToProcess) {
          if (!existingPaths.has(change.path)) {
            pendingChanges.push(change)
            existingPaths.add(change.path)
          }
        }
        getWatchUIAPI()?.setStatus('pending')
        getWatchUIAPI()?.setChangedFiles(pendingChanges)
      } else {
        onFilesChange(changesToProcess)
      }
    }, 200)
  }

  const daemonLog = (msg: string): void => {
    log(msg)
    if (surface) {
      surface.publishLog({ entries: [{ line: msg, ts: Date.now(), stream: 'stdout' }] }).catch(() => {})
    }
  }

  let lastBuildSaveConfig: SandstoneConfig['saveOptions'] | undefined
  let lastBuildConfigPath: string | undefined

  const publishActiveConfig = async (
    daemon: DaemonSurface,
    o: WatchOptions,
  ): Promise<void> => {
    if (!lastBuildSaveConfig || !lastBuildConfigPath) return
    const mode = o.library ? 'library' : 'pack'
    const outputDir = mode === 'pack'
      ? resolve(o.path, '.sandstone', 'output')
      : resolve(o.path, 'test', '.sandstone', 'output')
    await daemon.publishConfig({
      mode,
      configPath: lastBuildConfigPath,
      saveConfig: lastBuildSaveConfig,
      outputDir,
      projectRoot: resolve(o.path),
      loadedAt: new Date().toISOString(),
    })
  }
  let daemonConnected = false
  let deployAvailable = false
  let activeLogSub: { unattach(): Promise<void> } | undefined
  let offTriggerBuild: (() => void) | undefined
  daemonLog('Watch started')

  const surfaceInfo = (s: DaemonSurface) => {
    if (s instanceof Daemon) {
      return {
        hostType: s.host.type as HostType,
        hasCap: (name: string) => s.host.capabilities.has(name as Capability),
      }
    }
    return {
      hostType: s.welcome.hostType as HostType,
      hasCap: (name: string) => s.welcome.capabilities[name] === true,
    }
  }
  const disconnectSurface = () => {
    void activeLogSub?.unattach().catch(() => {})
    offTriggerBuild?.()
    offTriggerBuild = undefined
    activeLogSub = undefined
    daemonClient?.close()
    daemonClient = undefined
    surface = undefined
    daemonConnected = false
    deployAvailable = false
    getWatchUIAPI()?.setDeployAvailable(false)
    getWatchUIAPI()?.setDeployHasChanges(false)
  }

  const wireSurface = async (s: DaemonSurface): Promise<void> => {
    surface = s
    daemonConnected = true
    const info = surfaceInfo(s)
    const canStream = info.hasCap('writeFileStream') && info.hostType !== 'integrated'
    deployAvailable = canStream
    getWatchUIAPI()?.setDeployAvailable(canStream)
    void refreshDeployHasChanges()
    try {
      await publishActiveConfig(s, opts)
    } catch (err) {
      logWarn(`[watch] publishConfig failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      await s.publishWatcherStatus({
        connected: true,
        mode: (opts.library ? 'library' : 'pack') as 'pack' | 'library',
        manual: opts.manual ?? false,
        path: opts.path,
        pid: process.pid,
        at: new Date().toISOString(),
        testingMode,
      })
    } catch (err) {
      logWarn(`[watch] publishWatcherStatus failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (s.onTriggerBuild) {
      offTriggerBuild = s.onTriggerBuild(() => {
        if (!opts.manual) {
          logWarn('Erroneous manual build trigger received from daemon (probably an Agent via MCP). Not in manual mode, skipped.')
          return
        }
        if (pendingChanges.length === 0) {
          logWarn('Erroneous manual build trigger received from daemon (probably an Agent via MCP). No pending changes, skipped.')
          return
        }
        const toBuild = [...pendingChanges]
        pendingChanges = []
        onFilesChange(toBuild)
      })
    }
    const captured = s
    captured.setFallbackNotificationHandler(async (notif) => {
      if (notif.method === 'cancelTriggerBuild') {
        daemonLog('Build cancelled via daemon')
        if (currentBuildWorker) {
          void currentBuildWorker.terminate()
        }
        try {
          await captured.publishRebuild({
            state: 'failed',
            fileCount: 0,
            errorCount: 1,
            warningCount: 0,
            at: new Date().toISOString(),
            message: 'Cancelled by client',
          })
        } catch (err) {
          logWarn(`[watch] publishRebuild (cancelled) failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      if (notif.method === 'setBuildMode') {
        const params = notif.params as { mode?: 'normal' | 'test' } | undefined
        if (params?.mode === 'test' || params?.mode === 'normal') {
          daemonLog(`Build mode set to ${params.mode} via daemon`)
          setTestingMode(params.mode === 'test')
        }
      }
    })
    try {
      const sub = await s.attachLog()
      activeLogSub = sub
      sub.onLines((lines) => {
        if (suppressHostLog) return
        for (const entry of lines) {
          const body = entry.line.replace(MinecraftTimestampRegex, '')
          if (entry.stream === 'stdout' && !(weSpawnedIntegrated && shuttingDown.flag)) {
            log(chalk`{cyan [connect]} ${body}`)
          }
          if (entry.stream === 'stderr') {
            log(chalk`{cyan [connect]} {red ${body}}`)
          }
        }
      })
    } catch (err) {
      logWarn(`[watch] attachLog failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const ensureOwnDaemon = (): Promise<DaemonHandle> => {
    if (daemonHandle) return Promise.resolve(daemonHandle)
    if (!bootstrapInFlight) {
      bootstrapInFlight = (async () => {
        daemonLog('Starting in-process connect daemon')
        const connectSink = prepareConnectSink(opts.path)
        const resolved = await resolveHostAndConfig({
          projectRoot: opts.path,
          cliHostType: opts.hostType,
          sink: connectSink,
        })
        if (resolved.hostType === 'integrated') {
          daemonLog('Integrated connect host starting up...')
        }
        const { host, handle, spawnedByUs } = await startInProcessDaemon({
          projectRoot: opts.path,
          hostType: resolved.hostType,
          hostConfig: resolved.config,
          userProvidedHostSettings: resolved.userProvidedHostSettings,
          sink: connectSink,
          onHostReady: (h, spawnedByUs) => {
            weSpawnedIntegrated = spawnedByUs
            if (h.type === 'integrated') {
              const integrated = h as IntegratedHost
              setTimeout(() => daemonLog(chalk`Integrated connect host online! Join in-game at {yellow localhost${integrated.serverPort === 25565 ? '' : `:${integrated.serverPort}`}}`), 100)
            }
          },
        })
        skipNextReload = spawnedByUs && host.type === 'integrated'
        return handle
      })()
    }
    return bootstrapInFlight
  }

  const tryConnectDaemon = async () => {
    if (daemonConnected) return
    try {
      if (await endpointStatus(opts.path) === 'live') {
        const endpoint = await readEndpoint(opts.path)
        if (endpoint) {
          try {
            daemonClient = await DaemonClient.open({ endpoint })
            daemonLog('Connected to host daemon')
            await wireSurface(daemonClient)
            clearInterval(daemonPoll)
            daemonPoll = undefined
            daemonClient.onShutdown((reason) => {
              daemonLog(`Host daemon is shutting down (${reason}), will watch for a new daemon`)
              disconnectSurface()
              if (!daemonPoll) daemonPoll = setInterval(tryConnectDaemon, 5_000)
            })
            return
          } catch {
            logWarn('Having issues connecting to the daemon, this should never happen')
          }
        }
      }
    } catch {}

    if (opts.daemon && !daemonHandle) {
      try {
        const handle = await ensureOwnDaemon()
        await wireSurface(handle.daemon)
        clearInterval(daemonPoll)
        daemonPoll = undefined
        return
      } catch (err) {
        const hostType: HostType = opts.hostType ?? connectHost?.type ?? 'integrated'
        const isIntegrated = hostType === 'integrated'
        logWarn(`[watch] failed to start in-process daemon: ${err instanceof Error ? err.message : String(err)}`)
        if (isIntegrated) {
          clearInterval(daemonPoll)
          daemonPoll = undefined
        }
      }
    }
  }
  tryConnectDaemon().then(() => setInterval(tryConnectDaemon, 5_000))

  // Initial build
  await onFilesChange([])

  const linksFilePath = join(opts.path, '.sandstone', 'links.json')
  try {
    const linksData = JSON.parse(await fs.readText(linksFilePath)) as { links?: Record<string, { libraryPath: string }> }
    for (const entry of Object.values(linksData.links ?? {})) {
      const lv = join(entry.libraryPath, '.sandstone', 'link_version')
      if (!(await fs.pathExists(lv))) continue
      const onChange = () => onFilesChange([{ path: lv, category: 'dependencies' }])
      watchFile(lv, { interval: 500 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) onChange()
      })
      linkVersionWatchers.push({ file: lv })
    }
  } catch {}

  const defaultIgnore = ['**/.git/**/*', '**/.sandstone/**/*', '**/resources/cache/**/*', '**/*tmp*', '**/*.swp', 'lib/**/*']
  const cliIgnore = (opts.ignore ?? []).flatMap(p => p.split(',').filter(Boolean))
  const ignorePatterns = [...defaultIgnore, ...cliIgnore]

  subscription = await subscribe(
    opts.path,
    (err, events) => {
      if (err) {
        logError(err)
        return
      }
      handleEvents(events)
    },
    {
      ignore: ignorePatterns,
    }
  )
  sigintHandler = async () => await exit(subscription, currentBuildWorker, shuttingDown, weSpawnedIntegrated, log, unmountInk, sigintHandler, linkVersionWatchers, daemonPoll, daemonClient)
  process.on('SIGINT', sigintHandler)
}

async function cleanup(
  subscription: ParcelWatcher.AsyncSubscription,
  buildWorker: Worker | null | undefined,
  shuttingDown: { flag: boolean },
  weStartedIntegrated: boolean,
  log: LoggerSink['log'],
  unmountInk?: () => void,
  sigintHandler?: () => Promise<void>,
  linkVersionWatchers?: { file: string }[],
  daemonPoll?: ReturnType<typeof setInterval>,
  daemonClient?: DaemonClient,
  daemonHandle?: DaemonHandle,
) {
  if (sigintHandler) process.off('SIGINT', sigintHandler)
  shuttingDown.flag = true
  await subscription.unsubscribe()
  if (linkVersionWatchers) {
    for (const w of linkVersionWatchers) unwatchFile(w.file)
  }
  if (buildWorker) {
    void buildWorker.terminate()
  }
  if (daemonPoll) clearInterval(daemonPoll)
  if (daemonHandle) {
    if (weStartedIntegrated) {
      log('Integrated connect host shutting down...')
    }
    await daemonHandle.shutdown().catch(() => {})
    log('Integrated shutdown.')
  }
  daemonClient?.close()
  log('Watch stopped.')
  await logger.closeAll()
  // Allow TUI to render last log entries
  await new Promise<void>((res) => setTimeout(() => res(), 50))
  unmountInk?.()
}

async function exit(
  subscription: ParcelWatcher.AsyncSubscription,
  buildWorker: Worker | null | undefined,
  shuttingDown: { flag: boolean },
  weSpawnedIntegrated: boolean,
  log: LoggerSink['log'],
  unmountInk?: () => void,
  sigintHandler?: () => Promise<void>,
  linkVersionWatchers?: { file: string }[],
  daemonPoll?: ReturnType<typeof setInterval>,
  daemonClient?: DaemonClient,
  daemonHandle?: DaemonHandle,
) {
  log('Watch stopping...')
  await cleanup(subscription, buildWorker, shuttingDown, weSpawnedIntegrated, log, unmountInk, sigintHandler, linkVersionWatchers, daemonPoll, daemonClient, daemonHandle)
  process.exit(0)
}

function categorizeChange(eventPath: string): ChangeCategory {
  if (eventPath.includes('src/')) return 'src'
  if (eventPath.includes('resources/')) return 'resources'
  if (eventPath.endsWith('sandstone.config.ts')) return 'config'
  if (
    eventPath.endsWith('.lock') ||
    eventPath.endsWith('-lock.yml') ||
    eventPath.endsWith('-lock.json') ||
    eventPath.includes('node_modules/')
  ) {
    return 'dependencies'
  }
  return 'other'
}