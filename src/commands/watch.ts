import ParcelWatcher, { subscribe, type Event } from '@parcel/watcher'
import { watchFile, unwatchFile } from 'node:fs'
import { realpath } from 'fs/promises'
import React from 'react'
import { render } from 'ink'
import { join, relative, resolve } from 'path'

import { normalizePath } from '../utils/index.js'
import { _buildCommand, type BuildOptions, type BuildContext } from './build/index.js'
import type { ActiveSaveConfig } from '../utils/activeSaveConfig.js'
import { repackIfLinked } from './link.js'
import { WatchUI, getWatchUIAPI } from '../ui/WatchUI.js'
import { initLogger, log, logInfo, logWarn, logError, logDebug, logTrace, setLiveLogCallback } from '../ui/logger.js'
import type { TrackedChange, ChangeCategory } from '../ui/types.js'
import { resolveStackTrace } from '../utils/source-map.js'
import * as fs from '../utils/fs.js'
import { run, spawn } from '../utils/shell.js'
import { connect as openDaemonClient, type Client as DaemonClient } from './connect/client.js'
import { endpointStatus, readEndpoint } from './connect/endpoint-file.js'
import { deployDatapack, checkDeployState } from './deploy.js'

// Minecraft prefixes every stdout line with `[HH:MM:SS] [Thread/LEVEL]: `.
// Strip just the timestamp — keep `[Server thread/INFO]: ` (and friends)
// so the thread/level context survives into the watch log.
const MinecraftTimestampRegex = /^\[\d{2}:\d{2}:\d{2}\] /

// Console capture for watch mode - wraps console to redirect output to our log file
const originalConsole = globalThis.console
let consoleWrapped = false

// linkVersionWatchers is intentionally local to each watchCommand invocation
// (see below) — keeping it module-level used to leak fs.watchFile listeners
// across re-entrant runs because reassigning the array never unwatched the
// previous entries.

function enableConsoleCapture() {
  if (consoleWrapped) return
  consoleWrapped = true

  ;(globalThis.console as any).log = (...args: any[]) => log(...args)
  ;(globalThis.console as any).info = (...args: any[]) => logInfo(...args)
  ;(globalThis.console as any).warn = (...args: any[]) => logWarn(...args)
  ;(globalThis.console as any).error = (...args: any[]) => logError(args.join(' '))
  ;(globalThis.console as any).debug = (...args: any[]) => logDebug(...args)

  ;(globalThis.console as any).trace = (...args: any[]) => {
    const traceObj = { stack: '' }
    Error.captureStackTrace(traceObj, globalThis.console.trace)
    const cleanedStack = traceObj.stack
      .replace(/^Error\n/, '')
      .replace(/\?hot-hook=\d+/g, '')
      .replace(/file:\/\/\/?/g, '')

    // Resolve source maps for stack frames
    const stackLines = cleanedStack.split('\n')
    const traceStart = stackLines.findIndex(line => line.trimStart().startsWith('at '))
    const stackTrace = traceStart >= 0 ? stackLines.slice(traceStart).join('\n') : ''
    const resolvedStack = stackTrace ? resolveStackTrace(stackTrace) : cleanedStack

    logTrace(...args, '\n' + resolvedStack)
  }
}

function disableConsoleCapture() {
  if (!consoleWrapped) return
  consoleWrapped = false

  const methodsToRestore = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
  for (const method of methodsToRestore) {
    ;(globalThis.console as any)[method] = originalConsole[method].bind(originalConsole)
  }
}

export interface WatchOptions extends BuildOptions {
  manual?: boolean
  library?: boolean
  ignore?: string[]
}

export async function watchCommand(opts: WatchOptions) {
  let alreadyBuilding = false
  let needRebuild = false
  let pendingChanges: TrackedChange[] = []
  let buildContext: BuildContext | undefined
  let lastBuildFailed = false

  // `folder` is the build context — `test/` for library mode (the test
  // workspace is itself a mini datapack), `opts.path` for pack mode.
  const folder = opts.library ? join(opts.path, 'test') : opts.path

  // All late-binding state referenced by the `exit` arrow below. Hoisted
  // here so they're declared before render() — initial `onFilesChange([])`
  // at the bottom of this function calls `api.exit()` synchronously when
  // the project lacks `sandstone.config.ts`, which would otherwise hit
  // TDZ on these bindings.
  let daemonClient: DaemonClient | undefined
  let daemonPoll: ReturnType<typeof setInterval> | undefined
  let linkVersionWatchers: { file: string }[] = []
  let sigintHandler: (() => Promise<void>) | undefined

  let subscription: Awaited<ReturnType<typeof subscribe>>

  // Initialize logger and keep the cleanup function so we can flush +
  // close the underlying WriteStream (and drain pending writes) on exit.
  // Discarding the return value previously left the .sandstone/watch.log
  // FD open and let pendingWrites grow unbounded for the lifetime of the
  // watch session.
  // Logger lives at the project root regardless of mode — the watcher
  // session is a single process, the log should be easy to find.
  const closeLogger = initLogger(opts.path)

  // Set up live log callback to send to UI
  setLiveLogCallback((level, args) => {
    getWatchUIAPI()?.setLiveLog(level, args)
  })

  // Render Ink UI
  let unmountInk: (() => void) | undefined

  const handleManualRebuild = () => {
    if (pendingChanges.length > 0 && !alreadyBuilding) {
      daemonLog('Manual rebuild triggered')
      onFilesChange(pendingChanges)
      pendingChanges = []
    }
  }

  const handleDeploy = async () => {
    if (!daemonClient) {
      daemonLog('[watch] no sand connect daemon running — start one with `sand connect` to enable deploy')
      return
    }
    try {
      const result = await deployDatapack({ daemon: daemonClient, projectRoot: opts.path })
      daemonLog(`[watch] deployed ${result.archiveName} -> ${result.remotePath} (${result.bytesWritten} bytes)`)
      for (const dep of result.dependencies) {
        daemonLog(`[watch]   dep ${dep.name} -> ${dep.remotePath} (${dep.bytesWritten} bytes)`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      daemonLog(`[watch] deploy failed: ${message}`)
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

  const { unmount } = render(
    React.createElement(WatchUI, {
      manual: opts.manual ?? false,
      onManualRebuild: handleManualRebuild,
      onDeploy: handleDeploy,
      cwd: opts.path,
      // Since this isn't SIGINT, its fine that we don't await this
      exit: () => exit(subscription, unmountInk, closeLogger, sigintHandler, linkVersionWatchers, daemonPoll, daemonClient),
      // Cancels the watcher + unmounts the UI, runs the update commands,
      // then exits the process.
      onRunUpdates: async (commands) => {
        await cleanup(subscription, unmountInk, closeLogger, sigintHandler, linkVersionWatchers, daemonPoll, daemonClient)
        // Pick a shell that runs the user's command natively per platform.
        // POSIX: `sh -c <cmd>`; Windows: `cmd /c <cmd>`.
        const shellCmd = process.platform === 'win32' ? 'cmd' : 'sh'
        const shellArg = process.platform === 'win32' ? '/c' : '-c'
        // Run each command sequentially via the shell wrapper. The wrapper
        // already runs `.quiet().nothrow()` by default — we want stdout to
        // stream through to the terminal here, so pass `stdio: 'inherit'`
        // through `run`'s argv-style path.
        for (const cmd of commands) {
          try {
            console.log(`$ ${cmd}`)
            await run(shellCmd, [shellArg, cmd], { stdio: 'inherit', throws: false })
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
    // Synchronous check-and-set to prevent race conditions
    if (alreadyBuilding) {
      needRebuild = true
      // Accumulate changes for the next build
      for (const change of changes) {
        if (!pendingChanges.some(c => c.path === change.path)) {
          pendingChanges.push(change)
        }
      }
      return
    }
    alreadyBuilding = true

    const api = getWatchUIAPI()

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

      // If the user opted into linking this library (via `sand link` in this
      // directory), repack the tarball and refresh .sandstone/link_version
      // so consuming projects can pick up the change on their next build.
      await repackIfLinked(opts.path)
    }

    if (changes.length > 0) {
      // Bun ignores query params for module caching and doesn't support
      // MessagePort in register(), so hot-hook's invalidation mechanism is
      // non-functional. We just purged hot-hook from the CLI entirely —
      // now we just clear Bun's module cache for project source files
      // before re-importing. This is Bun-only.
      const resolvedFolder = normalizePath(await realpath(folder))
      const resolvedRoot = opts.library ? normalizePath(await realpath(opts.path)) : resolvedFolder

      let clearedCount = 0
      for (const key of Object.keys(require.cache)) {
        const normalizedKey = normalizePath(key)

        // Only clear modules within the project
        if (!normalizedKey.startsWith(resolvedFolder) && !normalizedKey.startsWith(resolvedRoot)) continue

        // Keep sandstone singleton cached so CLI and user code share the same pack instance
        if (normalizedKey.includes('/node_modules/sandstone/')) continue

        delete require.cache[key]
        clearedCount++
      }

      // If recovering from a failed build but no modules were in cache, Bun had a parse error
      // and won't be able to reimport. Exit and ask user to restart.
      if (lastBuildFailed && clearedCount === 0) {
        getWatchUIAPI()?.setStatus('error', 'Parse error - restart required')
        unmountInk?.()
        process.stderr.write('\n\x1b[33mBun encountered a parse error and cannot recover. Please restart the watch command.\x1b[0m\n\n')
        process.exit(1)
      }
    }

    // Replace global console during build to capture user console.log without messing up Ink UI
    enableConsoleCapture()
    let result
    try {
      result = await _buildCommand(opts, folder, buildContext, true)
    } finally {
      disableConsoleCapture()
    }

    // Store context for subsequent builds
    if (result.success && result.sandstoneConfig !== undefined) {
      buildContext = {
        sandstoneConfig: result.sandstoneConfig,
        sandstonePack: result.sandstonePack!,
        resetSandstonePack: result.resetSandstonePack!,
      }
      // Snapshot the deploy targets the build actually used. Re-publish
      // to the daemon on every successful build so MCP sees live state
      // (script-side mutations of `local.worldName` etc. propagate here
      // — `resolveActiveSaveConfig` alone wouldn't see them).
      lastBuildSaveConfig = result.activeSaveConfig
      lastBuildConfigPath = resolve(folder, 'sandstone.config.ts')
      void refreshDeployHasChanges()
    }

    api?.setBuildResult(result)

    // Push the terminal build state. Aggregate error/warning counts from
    // the result's `error` field (string, presence indicates failure —
    // granular counts aren't surfaced today; default to 0).
    if (daemonClient) {
      const state = result.success ? 'complete' : 'failed'
      void daemonClient.publishRebuild({
        state,
        fileCount: result.resourceCounts.functions + result.resourceCounts.other,
        errorCount: result.success ? 0 : 1,
        warningCount: 0,
        at: new Date().toISOString(),
        ...(result.success ? {} : result.error ? { message: result.error.slice(0, 500) } : {}),
      }).catch(() => {})
    }

    if (result.success) {
      daemonLog(`Build successful: ${result.resourceCounts.functions} functions, ${result.resourceCounts.other} others`)
      lastBuildFailed = false
      // If a daemon is connected, ask it to run `/reload` so the running
      // server picks up the rebuilt datapacks without a restart. Skipped
      // during the very first build (daemon hasn't connected yet) and
      // when no daemon is running for this project.
      if (daemonClient) {
        // Fire-and-forget: `reload` blocks the server until datapacks
        // finish reloading, which can take seconds. Awaiting it stalls
        // the watcher (and any subsequent rebuilds queued behind it).
        daemonLog('Sent /reload to host daemon')
        const packName = result.sandstoneConfig?.name
        daemonClient
          .executeRawCommand({ command: `say [Sandstone @ ${packName}] Updated pack(s) deployed, reloading...` })
          .catch(() => {})
        daemonClient.executeRawCommand({ command: 'reload' }).catch((err) => {
          logWarn(`[watch] daemon reload failed: ${err instanceof Error ? err.message : String(err)}`)
        })
        daemonClient
          .executeRawCommand({ command: `say [Sandstone @ ${packName}] Reload Finished!` })
          .catch(() => {})
      }
    } else {
      logError(result.error)
      lastBuildFailed = true
    }

    alreadyBuilding = false

    if (needRebuild) {
      needRebuild = false
      // Use accumulated pending changes, then clear them
      const nextChanges = [...pendingChanges]
      pendingChanges = []
      await onFilesChange(nextChanges)
    }
  }

  let restartTimeout: ReturnType<typeof setTimeout> | null = null
  let debouncedChanges: TrackedChange[] = [] // Accumulate changes during debounce period
  let debounceScheduled = false // Synchronous flag to prevent multiple timeouts

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
    // Whether changes require a full process restart
    let needsRestart = false

    // Filter out irrelevant events and categorize
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
      // Debounce restart to allow package manager to finish
      restartTimeout = setTimeout(restart, 500)
      return
    }

    // Accumulate changes, deduplicating by path
    for (const change of trackedChanges) {
      if (!debouncedChanges.some(c => c.path === change.path)) {
        debouncedChanges.push(change)
      }
    }

    // Use a synchronous flag to ensure only one timeout is scheduled
    // This prevents race conditions when parcel watcher fires multiple callbacks rapidly
    if (debounceScheduled) return

    debounceScheduled = true

    setTimeout(() => {
      debounceScheduled = false

      const changesToProcess = [...debouncedChanges]
      debouncedChanges = [] // Clear for next batch

      if (changesToProcess.length === 0) {
        return
      }

      if (opts.manual) {
        // In manual mode, accumulate changes and wait for user input (deduplicated)
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
        // Auto mode - rebuild immediately
        // onFilesChange handles the "already building" case internally
        onFilesChange(changesToProcess)
      }
    }, 200)
  }

  /**
   * Watcher-local `log` wrapper. Always forwards to the UI logger
   * (which writes the watch.log file for humans tailing it); when a
   * daemon is connected, also pushes the line(s) over the existing WS
   * via `publishLog`. The daemon keeps the canonical buffer that MCP
   * reads; the file write is just a side effect for humans.
   *
   * Declared LATE — after the daemon state below — so the closure
   * doesn't hit TDZ when invoked before `daemonClient` is declared.
   */
  const daemonLog = (msg: string): void => {
    log(msg)
    if (daemonClient) {
      // Intrinsic timestamp: stamp at the moment the watcher emits
      // the line, not on the daemon side. Captures "when did this
      // happen" rather than "when did the network land".
      const ts = Date.now()
      void daemonClient.publishLog({ entries: [{ line: msg, ts }] }).catch(() => {
        // Daemon may have just disconnected; no way to surface from
        // here. Swallow.
      })
    }
  }

  // The live saveConfig the last successful build actually used
  // (post-script mutations). Captured from `BuildResult.activeSaveConfig`
  // and re-published to the daemon whenever it changes or the daemon
  // reconnects. `undefined` until the first build completes.
  let lastBuildSaveConfig: ActiveSaveConfig | undefined
  let lastBuildConfigPath: string | undefined

  /**
   * Push the active saveConfig to the daemon — what the watcher will
   * actually deploy to. Reads from the closure-mutable `lastBuild*`
   * vars so the daemon's view always matches what the last build used
   * (not just the static CLI-merge).
   *
   * No-op (silently) when no build has run yet — the daemon keeps
   * whatever it had before (typically the boot-time disk load).
   */
  const publishActiveConfig = async (
    client: DaemonClient,
    o: WatchOptions,
  ): Promise<void> => {
    if (!lastBuildSaveConfig || !lastBuildConfigPath) return
    const mode = o.library ? 'library' : 'pack'
    const outputDir = mode === 'pack'
      ? resolve(o.path, '.sandstone', 'output')
      : resolve(o.path, 'test', '.sandstone', 'output')
    await client.publishConfig({
      mode,
      configPath: lastBuildConfigPath,
      saveConfig: lastBuildSaveConfig,
      outputDir,
      projectRoot: resolve(o.path),
      loadedAt: new Date().toISOString(),
    })
  }

  // Poll for a running `sand connect` daemon every 5s. When one appears,
  // open a WS client to it and keep it alive for the watcher's lifetime;
  // future iterations can use the client (currently a no-op hold — just
  // logged + cleaned up on exit). Stops polling once connected; restarts
  // when the daemon sends a `daemonShutdown` event so a subsequent
  // `sand connect` reconnects without restarting `sand watch`.
  // (daemonClient/daemonPoll declared at top — referenced by the exit
  // arrow passed to render())
  let daemonConnected = false
  let deployAvailable = false
  // Active log subscription + its unsubscribe + the daemonShutdown
  // unsubscribe — held so the shutdown handler (and `cleanup`) can
  // release them in one place.
  let activeLogSub: { unattach(): Promise<void> } | undefined
  let offDaemonShutdown: (() => void) | undefined
  let offTriggerBuild: (() => void) | undefined
  daemonLog('Watch started')
  const tryConnectDaemon = async () => {
    if (daemonConnected) return
    try {
      if (await endpointStatus(opts.path) !== 'live') return
      const endpoint = await readEndpoint(opts.path)
      if (!endpoint) return
      try {
        daemonClient = await openDaemonClient({ endpoint })
        daemonConnected = true
        daemonLog('Connected to host daemon')
        const welcome = daemonClient.welcome
        const canStream = welcome.capabilities['writeFileStream'] === true && welcome.hostType !== 'integrated'
        deployAvailable = canStream
        getWatchUIAPI()?.setDeployAvailable(canStream)
        void refreshDeployHasChanges()
        // Publish the active saveConfig so the daemon (and any MCP
        // client attached to it) sees what the watcher will actually
        // deploy to. Resolved via the shared helper so the values
        // match `_buildProject`'s inline merge exactly.
        try {
          await publishActiveConfig(daemonClient, opts)
        } catch (err) {
          logWarn(`[watch] publishConfig failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        // Push the watcher's runtime status — mode, manual flag, path,
        // PID. The daemon caches this and flips `connected: false` when
        // our WS session closes. MCP `sandstone://watcher-status`
        // resource answers agents asking "is a watcher running, and
        // how?".
        try {
          await daemonClient.publishWatcherStatus({
            connected: true,
            mode: (opts.library ? 'library' : 'pack') as 'pack' | 'library',
            manual: opts.manual ?? false,
            path: opts.path,
            pid: process.pid,
            at: new Date().toISOString(),
          })
        } catch (err) {
          logWarn(`[watch] publishWatcherStatus failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        // Subscribe to `triggerBuild` events so MCP `runWorkspaceBuild`
        // can ask us to fire a build. In manual mode this consumes
        // pending changes; otherwise the rebuild is just `onFilesChange([])`.
        if (daemonClient.onTriggerBuild) {
          offTriggerBuild = daemonClient.onTriggerBuild(() => {
            daemonLog('Trigger build received via daemon')
            if (!opts.manual) {
              // Auto-rebuild mode — just run unconditionally.
              void onFilesChange([])
              return
            }
            // Manual mode — consume pending changes.
            if (pendingChanges.length === 0) {
              daemonLog('Trigger received but no pending changes; running anyway')
              void onFilesChange([])
              return
            }
            const toBuild = [...pendingChanges]
            pendingChanges = []
            void onFilesChange(toBuild)
          })
        }
        // Subscribe to the host's log stream so the running server's
        // output shows up alongside the rebuild messages in the watch
        // log. Single-host daemons always expose `attachLog`.
        try {
          const sub = await daemonClient.attachLog()
          activeLogSub = sub
          sub.onLines((lines) => {
            for (const line of lines) log(`[connect] ${line.replace(MinecraftTimestampRegex, '')}`)
          })
        } catch (err) {
          logWarn(`[watch] attachLog failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        // Graceful shutdown: daemon broadcasts `daemonShutdown` before
        // closing the WS. React by logging, releasing the log
        // subscription, dropping the client, and restarting polling so a
        // subsequent `sand connect` reconnects automatically.
        offDaemonShutdown = daemonClient.onShutdown((reason) => {
          daemonLog(`Host daemon is shutting down (${reason}) — watching for a new daemon`)
          void activeLogSub?.unattach().catch(() => {})
          offTriggerBuild?.()
          offTriggerBuild = undefined
          activeLogSub = undefined
          offDaemonShutdown = undefined
          daemonClient?.close()
          daemonClient = undefined
          daemonConnected = false
          deployAvailable = false
          getWatchUIAPI()?.setDeployAvailable(false)
          getWatchUIAPI()?.setDeployHasChanges(false)
          if (!daemonPoll) daemonPoll = setInterval(tryConnectDaemon, 5_000)
        })
        // Stop polling — connection succeeded. The onShutdown handler
        // re-arms the poll if the daemon later disappears.
        clearInterval(daemonPoll)
        daemonPoll = undefined
      } catch {
        // Endpoint looked live but the WS handshake failed (port just
        // closed, secret rotated, etc.). Keep polling — a retry might
        // succeed, and the next status check will see the file as
        // stale-recent and skip.
      }
    } catch {
      // Status/read errors shouldn't kill the watcher — try again next tick.
    }
  }
  // Try once immediately so an already-running daemon links without
  // waiting for the first 5s tick. If that succeeds the interval is
  // cleared inside `tryConnectDaemon`; otherwise it keeps ticking.
  tryConnectDaemon()
  daemonPoll = setInterval(tryConnectDaemon, 5_000)

  // Initial build
  await onFilesChange([])

  // Also watch each linked library's `.sandstone/link_version` file via
  // fs.watchFile (parcel's subscribe only takes a single root). When the
  // library is re-packed, that file's mtime changes; the watch picks it
  // up and runs a rebuild, which calls syncLinkedLibraries and pulls in
  // the new tarball. We only watch link_version (not the whole .sandstone
  // dir) so the tarball write itself doesn't re-trigger.
  const linksFilePath = join(opts.path, '.sandstone', 'links.json')
  // linkVersionWatchers declared at top — referenced by the exit arrow
  // passed to render() before this point.
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

  // Handle cleanup on exit — hold the handler reference so cleanup() can
  // process.off() it. Previously every watchCommand invocation stacked a
  // new SIGINT listener that never got removed; on SIGINT they all fired
  // against the wrong subscription. (sigintHandler declared at top of
  // function so the exit arrow passed to render() can reference it
  // without TDZ.)
  sigintHandler = async () => await exit(subscription, unmountInk, closeLogger, sigintHandler, linkVersionWatchers, daemonPoll, daemonClient)
  process.on('SIGINT', sigintHandler)
}

async function cleanup(subscription: ParcelWatcher.AsyncSubscription, unmountInk?: () => void, closeLogger?: () => Promise<void>, sigintHandler?: () => Promise<void>, linkVersionWatchers?: { file: string }[], daemonPoll?: ReturnType<typeof setInterval>, daemonClient?: DaemonClient) {
  // Stops the parcel FS watcher + unmounts ink. Does NOT exit the process —
  // callers that want to run more code (e.g. update commands) should chain
  // their own logic before exiting.
  unmountInk?.()
  await subscription.unsubscribe()
  // Stop the fs.watchFile watchers for linked libraries' link_version files.
  if (linkVersionWatchers) {
    for (const w of linkVersionWatchers) unwatchFile(w.file)
  }
  // Stop the daemon-polling interval and close any live WS client. The
  // daemon-side `close` handler cascades-unattach every subscription on
  // this connection, so the log stream ends on its own without the
  // watcher having to track subscription handles.
  if (daemonPoll) clearInterval(daemonPoll)
  daemonClient?.close()
  // Detach our SIGINT handler so a stale watch can't intercept the next
  // process's Ctrl+C.
  if (sigintHandler) process.off('SIGINT', sigintHandler)
  // Flush + close the logger's WriteStream; release any pending writes.
  await closeLogger?.()
}

async function exit(
  subscription: ParcelWatcher.AsyncSubscription,
  unmountInk?: () => void,
  closeLogger?: () => Promise<void>,
  sigintHandler?: () => Promise<void>,
  linkVersionWatchers?: { file: string }[],
  daemonPoll?: ReturnType<typeof setInterval>,
  daemonClient?: DaemonClient,
) {
  log('Watch stopped')
  await cleanup(subscription, unmountInk, closeLogger, sigintHandler, linkVersionWatchers, daemonPoll, daemonClient)
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
