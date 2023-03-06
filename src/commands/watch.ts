import { Command, flags } from '@oclif/command'
import chokidar from 'chokidar'
import { buildProject } from '../build/buildProject'
import path from 'path'
import { getProjectFolders } from '../utils'
import type { Client } from 'minecraft-protocol'
import chalk from 'chalk'

export default class Watch extends Command {
  static description = 'Build the packs, and rebuild them on file change. ⛏'

  static examples = [
    '$ sand watch',
    '$ sand watch --verbose',
    '$ sand watch --verbose --dry',
  ]

  static flags = {
    help: flags.help({ char: 'h' }),
    dry: flags.boolean({ char: 'd', description: 'Do not save the pack. Mostly useful with `verbose`.' }),
    verbose: flags.boolean({ char: 'v', description: 'Log all resulting resources: functions, advancements...' }),
    namespace: flags.string({ description: 'The default namespace. Override the value specified in the configuration file.' }),
    world: flags.string({ description: 'The world to save the datapack in. Override the value specified in the configuration file.' }),
    root: flags.boolean({ description: 'Save the datapack & resource pack in the .minecraft/datapacks & .minecraft/resource_packs folders. Override the value specified in the configuration file.' }),
    clientPath: flags.string({ name: 'client-path', description: 'Path of the client folder. Override the value specified in the configuration file.' }),
    serverPath: flags.string({ name: 'server-path', description: 'Path of the server folder. Override the value specified in the configuration file.' }),
    // TODO: ssh
    name: flags.string({ description: 'Name of the datapack. Override the value specified in the configuration file.' }),
    description: flags.string({ description: 'Description of the datapack. Override the value specified in the configuration file.' }),
    formatVersion: flags.integer({ name: 'format', description: 'Pack format version. Override the value specified in the configuration file.' }),
    fullTrace: flags.boolean({ name: 'full-trace', description: 'Show the full stack trace on errors.' }),
    strictErrors: flags.boolean({ description: 'Stop datapack compilation on type errors.', default: false }),
    production: flags.boolean({ char: 'p', description: 'Runs Sandstone in production mode. This sets process.env.SANDSTONE_ENV to "production".', default: false }),
    autoReload: flags.integer({ description: 'Automatically reload your datapack in-game. Requires to open the world to LAN with cheats enabled, and to specify the port.', helpValue: 'port' }),
  }

  static args = [{
    name: 'path',
    description: 'Path of the folder containing source files.',
    required: true,
    default: './src',
  }, {
    name: 'config-path',
    description: 'Path of the sandstone.config.ts folder.',
    required: true,
    default: '.',
  }]

  async run() {
    const { args, flags } = this.parse(Watch)

    let alreadyBuilding: boolean = false
    let needRebuild: boolean = false

    let client: Client | null = null

    // TODO: add support for clients & resources that require restarts & world resets, sandstone-server should override the involved environment variables if mods are present that fix it
    if (flags.autoReload !== undefined) {
      try {
        client = (await require('minecraft-protocol')).createClient({
          username: 'SandstoneBot',
          host: 'localhost',
          port: flags.autoReload,
        })
      } catch (e) {
        console.log(chalk.rgb(255, 204, 0)`Failed to connect to localhost:${flags.autoReload}. The datapack won't be auto reloaded.`)
      }
    }

    const folders = getProjectFolders(args.path)

    async function onFilesChange(paths?: string[]) {
      if (alreadyBuilding) {
        // If the pack is already being built & another change was made,
        // notify that a rebuild is needed & stop there
        needRebuild = true
        return
      }

      alreadyBuilding = true

      await buildProject(flags, folders, paths)
      client?.write('chat', { message: '/reload' })
      alreadyBuilding = false

      if (needRebuild) {
        needRebuild = false
        await onFilesChange(paths)
      }
    }

    // Register ts-node
    const tsConfigPath = path.join(folders.rootFolder, 'tsconfig.json')

    require('ts-node').register({
      transpileOnly: !flags.strictErrors,
      project: tsConfigPath,
    })

    let timeout: NodeJS.Timeout | null = null
    let files: string[] = []

    chokidar.watch([
      path.join(folders.absProjectFolder, '/**/*'),
      path.join(folders.sandstoneConfigFolder, 'sandstone.config.ts'),
      path.join(folders.rootFolder, 'package.json'),
      path.join(folders.rootFolder, 'tsconfig.json'),
    ]).on('all', (event, path) => {
      if (event === 'addDir') {
        return
      }

      files.push(path)

      if (timeout) clearTimeout(timeout as any)
      timeout = setTimeout(() => {
        onFilesChange(files.length === 0 ? undefined : files)
        files = []
      }, 200)
    })
  }
}
