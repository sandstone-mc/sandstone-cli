import { register as tsEval } from 'ts-node'
import chokidar from 'chokidar'
import path from 'path'

import { buildProject } from '../build/index.js'
import { getProjectFolders } from '../utils.js'

type WatchOptions = {
    // Flags
    dry?: boolean
    verbose?: boolean
    root?: boolean
    fullTrace?: boolean
    strictErrors?: boolean

    // Values
    path: string,
    configPath: string,
    name?: string
    namespace?: string
    world?: string
    clientPath?: string
    serverPath?: string
    // TODO: ssh
    // TODO: implement auto /reload & F3+F
}

export async function watchCommand(opts: WatchOptions) {
    let alreadyBuilding: boolean = false
    let needRebuild: boolean = false

    // let client: Client | null = null

    // TODO: add support for clients & resources that require restarts & world resets, sandstone-server should override the involved environment variables if mods are present that fix it
    /*if (flags.autoReload !== undefined) {
      try {
        client = (await require('minecraft-protocol')).createClient({
          username: 'SandstoneBot',
          host: 'localhost',
          port: flags.autoReload,
        })
      } catch (e) {
        console.log(chalk.rgb(255, 204, 0)`Failed to connect to localhost:${flags.autoReload}. The datapack won't be auto reloaded.`)
      }
    }*/

    const folders = getProjectFolders(opts.path)

    async function onFilesChange() {
        if (alreadyBuilding) {
            // If the pack is already being built & another change was made,
            // notify that a rebuild is needed & stop there
            needRebuild = true
            return
        }

        alreadyBuilding = true

        await buildProject(opts, folders)
        //client?.write('chat', { message: '/reload' })
        alreadyBuilding = false

        if (needRebuild) {
            needRebuild = false
            await onFilesChange()
        }
    }

    // Register ts-node
    const tsConfigPath = path.join(folders.rootFolder, 'tsconfig.json')

    tsEval({
        transpileOnly: !opts.strictErrors,
        project: tsConfigPath,
    })

    let timeout: NodeJS.Timeout | null = null
    let files: string[] = []

    chokidar.watch([
        path.join(folders.absProjectFolder, '/**/*'),
        path.join(folders.sandstoneConfigFolder, 'sandstone.config.ts'),
        path.join(folders.rootFolder, 'package.json'),
        path.join(folders.rootFolder, 'tsconfig.json'),
        /* @ts-ignore */
    ]).on('all', (event, path) => {
        if (event === 'addDir') {
            return
        }

        files.push(path)

        if (timeout) clearTimeout(timeout as any)
        timeout = setTimeout(() => {
            onFilesChange()
            files = []
        }, 200)
    })
}