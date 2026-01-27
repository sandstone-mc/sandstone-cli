import { subscribe, type Event } from '@parcel/watcher'

import { getProjectFolders } from '../utils.js'
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

  const handleEvents = (events: Event[]) => {
    // Filter out irrelevant events
    const relevantEvents = events.filter(e => {
      const relativePath = e.path.toLowerCase()
      // Ignore node_modules, .sandstone, .git
      if (relativePath.includes('node_modules') ||
          relativePath.includes('.sandstone') ||
          relativePath.includes('.git')) {
        return false
      }
      return true
    })

    if (relevantEvents.length === 0) return

    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      const changedFiles = relevantEvents.map(e => e.path).join(', ')
      console.log(`\nFile changed: ${changedFiles}\nRebuilding...\n`)
      onFilesChange()
    }, 200)
  }

  console.log('Watching source for changes. Press Ctrl+C to exit.\n')

  // Initial build
  await onFilesChange()

  // Watch the project folder
  const projectSubscription = await subscribe(
    folders.absProjectFolder,
    (err, events) => {
      if (err) {
        console.error('Watch error:', err)
        return
      }
      handleEvents(events)
    }
  )

  // Watch config file (in sandstoneConfigFolder)
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
    }
  )

  // Watch root folder for package.json and tsconfig.json changes
  const rootSubscription = await subscribe(
    folders.rootFolder,
    (err, events) => {
      if (err) {
        console.error('Watch error:', err)
        return
      }
      // Only react to package.json or tsconfig.json changes
      const rootEvents = events.filter(e =>
        e.path.endsWith('package.json') || e.path.endsWith('tsconfig.json')
      )
      if (rootEvents.length > 0) {
        handleEvents(rootEvents)
      }
    },
    {
      ignore: ['node_modules', '.sandstone', '.git', 'src']
    }
  )

  // Handle cleanup on exit
  process.on('SIGINT', async () => {
    console.log('\nStopping watch...')
    await projectSubscription.unsubscribe()
    await configSubscription.unsubscribe()
    await rootSubscription.unsubscribe()
    process.exit(0)
  })
}
