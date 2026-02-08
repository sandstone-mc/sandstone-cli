import { spawn } from 'node:child_process'
import ParcelWatcher, { subscribe, type Event } from '@parcel/watcher'
import React from 'react'
import { render } from 'ink'

import { normalizePath } from '../utils.js'
import { _buildCommand, type BuildOptions, type BuildContext, enableConsoleCapture, disableConsoleCapture } from './build.js'
import { WatchUI, getWatchUIAPI } from '../ui/WatchUI.js'
import { initLogger, log, logError, setLiveLogCallback } from '../ui/logger.js'
import type { TrackedChange, ChangeCategory } from '../ui/types.js'
import { hot } from '@sandstone-mc/hot-hook'
import fs from 'fs-extra'
import { join } from 'node:path'

export interface WatchOptions extends BuildOptions {
  manual?: boolean
  library?: boolean
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

  // Initialize logger
  initLogger(folder)

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
      // Since this isn't SIGINT, its fine that we don't await this
      exit: () => exit(subscription, unmountInk)
    }),
    { patchConsole: false }
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
    log('Building...', changes.map(c => c.path).join(', '))

    const libChanges = opts.library && Object.hasOwn(globalThis, 'Bun') ? changes.filter((change) => !change.path.includes('test/')) : []

    if (libChanges.length !== 0) {
      /* @ts-ignore */
      const CLI = Bun.spawn(['bun', 'dev:build'], {
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdout: 'ignore',
        stderr: 'ignore',
      })

      await CLI.exited
    }

    // Initialize hot-hook only once on the first build
    if (!hotInitialized) {
      await hot.init({
        root: join(folder, JSON.parse(await fs.readFile(join(folder, 'package.json'), 'utf-8'))['module']),
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
      const endsTs = eventPath.endsWith('.ts')

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
        // In manual mode, accumulate changes and wait for user input
        pendingChanges = [...pendingChanges, ...changesToProcess]
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
      ignore: ['**/.git/**/*', '**/.sandstone/**/*', '**/resources/cache/**/*', '**/*tmp*', 'lib/**/*'],
    }
  )

  // Handle cleanup on exit
  process.on('SIGINT', async () => await exit(subscription, unmountInk))
}

async function exit(subscription: ParcelWatcher.AsyncSubscription, unmountInk?: () => void) {
  log('Watch stopped')
  unmountInk?.()
  await subscription.unsubscribe()
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