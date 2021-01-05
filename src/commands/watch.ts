import { Command, flags } from '@oclif/command'
import chokidar from 'chokidar'
import debounce from 'lodash.debounce'
import { buildProject } from '../buildProject'
import path from 'path'
import { getProjectFolders } from '../utils'

export default class Watch extends Command {
  static description = 'Build the datapack, and rebuild it on file change. ⛏'

  static examples = [
    '$ sand watch',
    '$ sand watch --verbose',
    '$ sand watch --verbose --dry',
  ]

  static flags = {
    help: flags.help({ char: 'h' }),
    dry: flags.boolean({char: 'd', description: 'Do not save the datapack. Mostly useful with `verbose`.'}),
    verbose: flags.boolean({char: 'v', description: 'Log all resulting resources: functions, advancements...'}),
    namespace: flags.string({description: 'The default namespace. Override the value specified in the configuration file.'}),
    world: flags.string({description: 'The world to save the data pack in. Override the value specified in the configuration file.'}),
    root: flags.boolean({description: 'Save the data pack in the `.minecraft/datapacks` folder. Override the value specified in the configuration file.'}),
    path: flags.string({description: 'The path to save the data pack at. Override the value specified in the configuration file.'}),
    minecraftPath: flags.string({name: 'minecraft-path', description: 'Path of the .minecraft folder. Override the value specified in the configuration file.'}),
    name: flags.string({description: 'Name of the data pack. Override the value specified in the configuration file.'}),
    description: flags.string({description: 'Description of the data pack. Override the value specified in the configuration file.'}),
    formatVersion: flags.integer({name: 'format', description: 'Pack format version. Override the value specified in the configuration file.'}),
    fullTrace: flags.boolean({name: 'full-trace', description: 'Show the full stack trace on errors.'}),
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

    const folders = getProjectFolders(args.path)

    async function onFileChange() {
      if (alreadyBuilding) {
        // If the pack is already being built & another change was made,
        // notify that a rebuild is needed & stop there
        needRebuild = true
        return
      }

      alreadyBuilding = true
      
      // Delete the entire cache to prevent artifacts from previous builds
      Object.keys(require.cache).forEach(key => delete require.cache[key])

      await buildProject(flags, folders)
      alreadyBuilding = false
      
      if (needRebuild) {
        needRebuild = false
        await onFileChange()
      }
    }

    // Register ts-node
    require('ts-node').register({
      transpileOnly: true,
      project: path.join(folders.rootFolder, 'tsconfig.json'),
    })
    

    chokidar.watch([
      path.join(folders.absProjectFolder, '/**/*'),
      path.join(folders.sandstoneConfigFolder, 'sandstone.config.ts'),
      path.join(folders.rootFolder, 'package.json'),
      path.join(folders.rootFolder, 'tsconfig.json'),
    ]).on('all', debounce(onFileChange, 200))
  }
}
