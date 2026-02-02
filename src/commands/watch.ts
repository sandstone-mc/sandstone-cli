import { spawn } from 'node:child_process'
import { subscribe, type Event } from '@parcel/watcher'

import { getProjectFolders, normalizePath } from '../utils.js'
import { buildCommand, type BuildOptions } from './build.js'

export async function watchCommand(opts: BuildOptions) {
  let alreadyBuilding = false
  let needRebuild = false

  const folders = getProjectFolders(opts.path)

  async function onFilesChange() {
    if (alreadyBuilding) {
      needRebuild = true
      return
    }

    alreadyBuilding = true

    await buildCommand(opts, folders)

    alreadyBuilding = false

    if (needRebuild) {
      needRebuild = false
      await onFilesChange()
    }
  }

  let timeout: ReturnType<typeof setTimeout> | null = null
  let restartTimeout: ReturnType<typeof setTimeout> | null = null

  function restart() {
    console.log('\nRestarting watch process...\n')

    const [runtime, ...args] = process.argv
    const child = spawn(runtime, args, {
      stdio: 'inherit',
      detached: true,
    })
    child.unref()

    process.exit(0)
  }

  const handleEvents = (events: Event[]) => {
    // Whether changes require a full process restart
    let needsRestart = false

    // Filter out irrelevant events
    const relevantEvents = events.filter(e => {
      const eventPath = normalizePath(e.path)


      const lockFile = eventPath.endsWith('.lock') || eventPath.endsWith('-lock.yml') || eventPath.endsWith('-lock.json')

      if (lockFile || eventPath.includes('node_modules/') || eventPath.endsWith('sandstone.config.ts')) {
        needsRestart = true
      }

      const inSrc = eventPath.includes('src/')
      const inResources = eventPath.includes('resources/')
      const endsJs = eventPath.endsWith('.js')
      const endsJson = eventPath.endsWith('.json')
      const endsTs = eventPath.endsWith('.ts')
      

      return inSrc || inResources || endsJs || endsJson || endsTs
    })

    if (relevantEvents.length === 0) {
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

    if (timeout) {
      clearTimeout(timeout)
    }

    timeout = setTimeout(() => {
      const changedFiles = relevantEvents.map(e => e.path).join(', ')
      console.log(`\nFile changed: ${changedFiles}\nRebuilding...\n`)
      onFilesChange()
    }, 200)
  }

  console.log('Watching source for changes. Press Ctrl+C to exit.\n')

  // Initial build
  await onFilesChange()

  const subscriptions: Awaited<ReturnType<typeof subscribe>>[] = []

  // Check if all folders are the same path
  const allSamePath =
    folders.absProjectFolder === folders.sandstoneConfigFolder &&
    folders.absProjectFolder === folders.rootFolder

  if (allSamePath) {
    // Use a single watcher for all events
    const subscription = await subscribe(
      folders.absProjectFolder,
      (err, events) => {
        if (err) {
          console.error('Watch error:', err)
          return
        }
        handleEvents(events)
      },
      {
        ignore: [ '.git/**/*', '.sandstone/**/*', 'resources/cache/**/*' ]
      }
    )
    subscriptions.push(subscription)
  } else {
    subscriptions.push(...await createSplitSubscriptions(folders, handleEvents))
  }

  // Handle cleanup on exit
  process.on('SIGINT', async () => {
    console.log('\nStopping watch...')
    await Promise.all(subscriptions.map(s => s.unsubscribe()))
    process.exit(0)
  })
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
        console.error('Watch error:', err)
        return
      }
      handleEvents(events)
    },
    {
      ignore: [ '.git/**/*', '.sandstone/**/*', 'resources/cache/**/*' ]
    }
  )
  subscriptions.push(projectSubscription)

  // Watch config file (in sandstoneConfigFolder) if different from project folder
  if (folders.sandstoneConfigFolder !== folders.absProjectFolder) {
    const configSubscription = await subscribe(
      folders.sandstoneConfigFolder,
      (err, events) => {
        if (err) {
          console.error('Watch error:', err)
          return
        }
        // Only react to sandstone.config.ts changes
        const configEvents = events.filter(e =>
          e.path.endsWith('sandstone.config.ts')
        )
        if (configEvents.length > 0) {
          handleEvents(configEvents)
        }
      },
      {
        ignore: [ '!sandstone.config.ts', '**/*' ]
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
          console.error('Watch error:', err)
          return
        }
        const rootEvents = events.filter(e => e.path.endsWith('.json'))

        if (rootEvents.length > 0) {
          handleEvents(rootEvents)
        }
      },
      {
        ignore: [ '.git/**/*', '.sandstone/**/*', 'resources/cache/**/*' ]
      }
    )
    subscriptions.push(rootSubscription)
  }

  return subscriptions
}
