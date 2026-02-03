import { spawn } from 'node:child_process'
import ParcelWatcher, { subscribe, type Event } from '@parcel/watcher'
import React from 'react'
import { render } from 'ink'

import { getProjectFolders, normalizePath } from '../utils.js'
import { _buildCommand, type BuildOptions, type BuildContext, enableConsoleCapture, disableConsoleCapture } from './build.js'
import { WatchUI, getWatchUIAPI } from '../ui/WatchUI.js'
import { initLogger, log, logError, setLiveLogCallback } from '../ui/logger.js'
import type { TrackedChange, ChangeCategory } from '../ui/types.js'
import { hot } from '@sandstone-mc/hot-hook'
import fs from 'fs-extra'
import { join } from 'node:path'

export interface WatchOptions extends BuildOptions {
  manual?: boolean
}

async function exit(subscriptions: ParcelWatcher.AsyncSubscription[], unmountInk?: () => void) {
  log('Watch stopped')
  unmountInk?.()
  await Promise.all(subscriptions.map((s) => s.unsubscribe()))
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

export async function watchCommand(opts: WatchOptions) {
  let alreadyBuilding = false
  let needRebuild = false
  let pendingChanges: TrackedChange[] = []
  let buildContext: BuildContext | undefined
  let hotInitialized = false
  let lastBuildId = 0 // Used to deduplicate rapid build triggers

  const folders = getProjectFolders(opts.path)

  // Initialize logger
  initLogger(folders.rootFolder)

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
      exit: () => exit(subscriptions, unmountInk)
    })
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

    // Increment build ID to deduplicate
    const currentBuildId = ++lastBuildId
    const api = getWatchUIAPI()

    api?.setStatus('building')
    api?.setChangedFiles(changes)
    log('Building...', changes.map(c => c.path).join(', '))

    // Initialize hot-hook only once on the first build
    if (!hotInitialized) {
      await hot.init({
        root: join(folders.rootFolder, JSON.parse(await fs.readFile(join(folders.rootFolder, 'package.json'), 'utf-8'))['module']),
        // Ensure sandstone remains a singleton so CLI and user code share the same pack instance
        globalSingletons: ['**/node_modules/sandstone/**', '**/sandstone/dist/**'],
        // Disable hot-hook's internal watcher - we use parcel watcher and notify hot-hook
        watch: false,
      })
      hotInitialized = true
    }

    // Notify hot-hook about file changes so it can invalidate module versions
    // This must happen BEFORE re-importing so versions are incremented
    for (const change of changes) {
      hot.notifyFileChange(change.path)
    }
    // Small delay to let the loader process the invalidations
    if (changes.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    // Replace global console during build to capture user console.log without messing up Ink UI
    enableConsoleCapture()
    let result
    try {
      result = await _buildCommand(opts, folders, buildContext, true)
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
    } else {
      logError(result.error)
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

  const subscriptions: Awaited<ReturnType<typeof subscribe>>[] = []

  // TODO: The three-folder concept (projectFolder, sandstoneConfigFolder, rootFolder) is being
  // deprecated. Always use a single watcher from rootFolder to avoid race conditions.
  if (true) {
    const watchFolder = folders.rootFolder
    // Use a single watcher for all events
    const subscription = await subscribe(
      watchFolder,
      (err, events) => {
        if (err) {
          logError(err)
          return
        }
        handleEvents(events)
      },
      {
        ignore: ['.git/**/*', '.sandstone/**/*', 'resources/cache/**/*', '**/*tmp*'],
      }
    )
    subscriptions.push(subscription)
  } else {
    subscriptions.push(...(await createSplitSubscriptions(folders, handleEvents)))
  }

  // Handle cleanup on exit
  process.on('SIGINT', async () => await exit(subscriptions, unmountInk))
}

async function createSplitSubscriptions(
  folders: ReturnType<typeof getProjectFolders>,
  handleEvents: (events: Event[]) => void
) {
  const subscriptions: Awaited<ReturnType<typeof subscribe>>[] = []

  // Watch the project folder
  const projectSubscription = await subscribe(
    folders.absProjectFolder,
    (err, events) => {
      if (err) {
        logError(err)
        return
      }
      handleEvents(events)
    },
    {
      ignore: ['.git/**/*', '.sandstone/**/*', 'resources/cache/**/*'],
    }
  )
  subscriptions.push(projectSubscription)

  // Watch config file (in sandstoneConfigFolder) if different from project folder
  if (folders.sandstoneConfigFolder !== folders.absProjectFolder) {
    const configSubscription = await subscribe(
      folders.sandstoneConfigFolder,
      (err, events) => {
        if (err) {
          logError(err)
          return
        }
        // Only react to sandstone.config.ts changes
        const configEvents = events.filter((e) =>
          e.path.endsWith('sandstone.config.ts')
        )
        if (configEvents.length > 0) {
          handleEvents(configEvents)
        }
      },
      {
        ignore: ['!sandstone.config.ts', '**/*'],
      }
    )
    subscriptions.push(configSubscription)
  }

  // Watch root folder for package.json and tsconfig.json changes if different from project folder
  if (folders.rootFolder !== folders.absProjectFolder) {
    const rootSubscription = await subscribe(
      folders.rootFolder,
      (err, events) => {
        if (err) {
          logError(err)
          return
        }
        const rootEvents = events.filter((e) => e.path.endsWith('.json'))

        if (rootEvents.length > 0) {
          handleEvents(rootEvents)
        }
      },
      {
        ignore: ['.git/**/*', '.sandstone/**/*', 'resources/cache/**/*'],
      }
    )
    subscriptions.push(rootSubscription)
  }

  return subscriptions
}
