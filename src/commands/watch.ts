import { spawn } from 'node:child_process'
import ParcelWatcher, { subscribe, type Event } from '@parcel/watcher'
import React from 'react'
import { render } from 'ink'

import { normalizePath } from '../utils/index.js'
import { _buildCommand, type BuildOptions, type BuildContext } from './build/index.js'
import { repackIfLinked } from './link.js'
import { WatchUI, getWatchUIAPI } from '../ui/WatchUI.js'
import { initLogger, log, logInfo, logWarn, logError, logDebug, logTrace, setLiveLogCallback } from '../ui/logger.js'
import type { TrackedChange, ChangeCategory } from '../ui/types.js'
import { hot } from '@sandstone-mc/hot-hook'
import { resolveStackTrace } from '../utils/source-map.js'
import fs from 'fs-extra'
import { join, relative } from 'node:path'

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
  let hotInitialized = false
  let lastBuildFailed = false

  const folder = opts.library ? join(opts.path, 'test') : opts.path

  let subscription: Awaited<ReturnType<typeof subscribe>>

  // Initialize logger and keep the cleanup function so we can flush +
  // close the underlying WriteStream (and drain pending writes) on exit.
  // Discarding the return value previously left the .sandstone/watch.log
  // FD open and let pendingWrites grow unbounded for the lifetime of the
  // watch session.
  const closeLogger = initLogger(folder)

  // Set up live log callback to send to UI
  setLiveLogCallback((level, args) => {
    getWatchUIAPI()?.setLiveLog(level, args)
  })

  // Render Ink UI
  let unmountInk: (() => void) | undefined

  const handleManualRebuild = () => {
    if (pendingChanges.length > 0 && !alreadyBuilding) {
      log('Manual rebuild triggered')
      onFilesChange(pendingChanges)
      pendingChanges = []
    }
  }

  const { unmount } = render(
    React.createElement(WatchUI, {
      manual: opts.manual ?? false,
      onManualRebuild: handleManualRebuild,
      cwd: opts.path,
      // Since this isn't SIGINT, its fine that we don't await this
      exit: () => exit(subscription, unmountInk, closeLogger, sigintHandler, linkVersionWatchers),
      // Cancels the watcher + unmounts the UI, runs the update commands,
      // then exits the process.
      onRunUpdates: async (commands) => {
        // Fully stop the FS watcher + ink BEFORE running commands — file
        // system changes from the update commands shouldn't re-trigger a
        // rebuild or cause the UI to flicker.
        await cleanup(subscription, unmountInk, closeLogger, sigintHandler, linkVersionWatchers)
        // Pick a shell that runs the user's command natively per platform.
        // POSIX: `sh -c <cmd>`; Windows: `cmd /c <cmd>`.
        const shellCmd = process.platform === 'win32' ? 'cmd' : 'sh'
        const shellArg = process.platform === 'win32' ? '/c' : '-c'
        // Run each command sequentially. Best-effort — failures are logged
        // but don't block subsequent commands. Uses Node-standard child_process
        // so the CLI has no hard bun-runtime dependency.
        for (const cmd of commands) {
          try {
            console.log(`$ ${cmd}`)
            const child = spawn(shellCmd, [shellArg, cmd], {
              stdio: ['ignore', 'inherit', 'inherit'],
              env: process.env,
            })
            await new Promise<void>((resolve) => {
              child.on('close', () => resolve())
              child.on('error', () => resolve())
            })
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
    log('Building...', changes.map(c => './' + relative(opts.path, c.path).replace(/\\/g, '/')).join(', '))

    const packageJSON = JSON.parse(await fs.readFile(join(folder, 'package.json'), 'utf-8'))

    const libChanges = Object.hasOwn(globalThis, 'Bun') ? changes.filter((change) => !change.path.includes('test/')) : []

    const libFolder = join(opts.path, 'lib')

    if (
      (!opts.library && (
        !packageJSON['module']?.endsWith('.ts')
        || !(await fs.exists(join(opts.path, 'sandstone.config.ts')))
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
      /* @ts-ignore */
      const CLI = Bun.spawn(['bun', 'dev:build'], {
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

    // Initialize hot-hook only once on the first build
    if (!hotInitialized) {
      await hot.init({
        root: join(folder, packageJSON['module']),
        // Ensure sandstone remains a singleton so CLI and user code share the same pack instance
        globalSingletons: ['**/node_modules/sandstone/**', '**/sandstone/dist/**'],
        // Disable hot-hook's internal watcher - we use parcel watcher and notify hot-hook
        watch: false,
      })
      hotInitialized = true
    }

    if (Object.hasOwn(globalThis, 'Bun') && changes.length > 0) {
      // Bun ignores query params for module caching and doesn't support MessagePort
      // in register(), so hot-hook's invalidation mechanism is non-functional.
      // Instead, clear Bun's module cache for project source files before re-importing.
      const resolvedFolder = normalizePath(await fs.realpath(folder))
      const resolvedRoot = opts.library ? normalizePath(await fs.realpath(opts.path)) : resolvedFolder

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
    } else {
      // Node.js path: use hot-hook's message port invalidation
      for (const change of changes) {
        hot.notifyFileChange(change.path)
      }
      if (libChanges.length !== 0) {
        const libModuleFiles = await fs.readdir(join(opts.path, 'lib'), { recursive: true })
        for (const file of libModuleFiles) {
          hot.notifyFileChange(join(opts.path, 'lib', file as unknown as string))
        }
      }
      // Small delay to let the loader process the invalidations
      if (changes.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 10))
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
    }

    api?.setBuildResult(result)

    if (result.success) {
      log(`Build successful: ${result.resourceCounts.functions} functions, ${result.resourceCounts.other} others`)
      lastBuildFailed = false
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
    log('Restarting watch process...')
    getWatchUIAPI()?.setStatus('restarting')

    const [runtime, ...args] = process.argv
    const child = spawn(runtime, args, {
      stdio: 'inherit',
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

  log('Watch started')

  // Initial build
  await onFilesChange([])

  // Also watch each linked library's `.sandstone/link_version` file via
  // fs.watchFile (parcel's subscribe only takes a single root). When the
  // library is re-packed, that file's mtime changes; the watch picks it
  // up and runs a rebuild, which calls syncLinkedLibraries and pulls in
  // the new tarball. We only watch link_version (not the whole .sandstone
  // dir) so the tarball write itself doesn't re-trigger.
  const linksFilePath = join(opts.path, '.sandstone', 'links.json')
  const linkVersionWatchers: { file: string }[] = []
  try {
    const linksData = JSON.parse(await fs.readFile(linksFilePath, 'utf-8')) as { links?: Record<string, { libraryPath: string }> }
    for (const entry of Object.values(linksData.links ?? {})) {
      const lv = join(entry.libraryPath, '.sandstone', 'link_version')
      if (!(await fs.pathExists(lv))) continue
      const onChange = () => onFilesChange([{ path: lv, category: 'dependencies' }])
      fs.watchFile(lv, { interval: 500 }, (curr, prev) => {
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
  // against the wrong subscription.
  const sigintHandler = async () => await exit(subscription, unmountInk, closeLogger, sigintHandler, linkVersionWatchers)
  process.on('SIGINT', sigintHandler)
}

async function cleanup(subscription: ParcelWatcher.AsyncSubscription, unmountInk?: () => void, closeLogger?: () => Promise<void>, sigintHandler?: () => Promise<void>, linkVersionWatchers?: { file: string }[]) {
  // Stops the parcel FS watcher + unmounts ink. Does NOT exit the process —
  // callers that want to run more code (e.g. update commands) should chain
  // their own logic before exiting.
  unmountInk?.()
  await subscription.unsubscribe()
  // Stop the fs.watchFile watchers for linked libraries' link_version files.
  if (linkVersionWatchers) {
    for (const w of linkVersionWatchers) fs.unwatchFile(w.file)
  }
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
) {
  log('Watch stopped')
  await cleanup(subscription, unmountInk, closeLogger, sigintHandler, linkVersionWatchers)
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