import { Command, flags } from '@oclif/command'
import chalk from 'chalk'
import { execSync } from 'child_process'
import fs from 'fs-extra'
import inquirer from 'inquirer'
import path from 'path'
import util from 'util'
import { getFlagOrPrompt, getWorldsList, hasYarn } from '../utils'
import { nanoid } from 'nanoid'

function toJson(obj: any, pretty: boolean = false): string {
  return util.inspect(obj, {
      depth: +Infinity,
      colors: false,
      breakLength: +Infinity,
      compact: !pretty,
      maxArrayLength: +Infinity,
    })
}

export default class Create extends Command {
  static description = 'Create a new Sandstone project.'

  static examples = [
    '$ sand create my-pack',
  ]

  static flags = {
    help: flags.help({ char: 'h' }),
    yarn: flags.boolean({ description: 'Use yarn instead of npm.', env: 'USE_YARN', exclusive: ['npm'] }),
    npm: flags.boolean({ description: 'Use npm.', env: 'USE_NPM', exclusive: ['yarn'] }),
    library: flags.boolean({ char: 't', env: 'LIBRARY', description: 'Whether the project will be a library for use in other Sandstone projects.'}),
    version: flags.string({ char: 'v', env: 'SANDSTONE_VERSION', description: `What version of Sandstone you'd like to create a project for.`}),
    'pack-name': flags.string({ char: 'd', env: 'PACK_NAME', description: 'The name of the pack(s).' }),
    namespace: flags.string({ char: 'n', env: 'NAMESPACE', description: 'The default namespace that will be used.' }),
    'save-root': flags.boolean({ char: 'r', env: 'SAVE_ROOT', description: 'Save the data pack & resource pack in the .minecraft/datapacks & .minecraft/resource_packs folders. Not compatible with --world.', exclusive: ['world'] }),
    world: flags.string({ char: 'w', env: 'WORLD', description: 'The world to save the packs in. Not compatible with --save-root or --server', exclusive: ['save-root', 'server'] }),
    'server-path': flags.string({ char: 's', env: 'SERVER_PATH', description: 'The server path to write the server-side packs at. Not compatible with --world.', exclusive: ['world'] }),
    'client-path': flags.string({ char: 'c', env: 'CLIENT_PATH', description: 'The client path to write packs at.' }),
  }

  static args = [{
    name: 'project-name',
    description: 'Name of the project folder. This is not the name of the output pack(s).',
    required: true,
  }]

  async run() {
    const { args, flags } = this.parse(Create)

    const projectPath = path.resolve(args['project-name'])
    const projectName = path.basename(projectPath)

    const projectType = Boolean(await getFlagOrPrompt(flags, 'library', {
      message: 'Whether your project will be a library for use in other Sandstone projects >',
      type: 'input',
      default: false
    })) === true ? 'library' : 'pack'

    const versions = [['0.13.6', '0.5.4'], ['0.14.0-alpha.13', '0.5.4'], ['0.14.0-alpha.19', '0.6.2']] as const

    const stableIndex = 0

    const { sandstoneVersion } = await inquirer.prompt({
      name: 'sandstoneVersion',
      type: 'list',
      message: 'Which version of Sandstone do you want to use? These are the only supported versions for new projects.',
      choices: versions.map(version => ({
        name: version[0].includes('alpha') ? `Alpha Version ${version[0].split('.')[3]} for release ${version[0].split('.')[1]}` : `Major Version 0.${version[0].split('.')[1]}`
      })),
      default: stableIndex
    }) as {
      sandstoneVersion: typeof versions[any]
    }

    let packName: string = ''

    let namespace: string = ''

    if (projectType === 'pack') {
      packName = await getFlagOrPrompt(flags, 'pack-name', {
        message: 'Name of your output pack(s) (can be changed later) >',
        type: 'input',
        default: projectName,
      })

      namespace = await getFlagOrPrompt(flags, 'namespace', {
        message: 'Default namespace (can be changed later) >',
        default: 'default',
      })
    }

    // Find the save directory
    const saveOptions: {
      root?: boolean | undefined
      world?: string | undefined
      serverPath?: string | undefined
      clientPath?: string | undefined
    } = {}

    if (sandstoneVersion[0].includes('alpha') && Number(sandstoneVersion[0].split('.')[3]) >= 19) {
      if (flags['save-root']) {
        saveOptions.root = true
      } else if (flags.world) {
        saveOptions.world = flags.world
      } else if (flags['server-path']) {
        saveOptions.serverPath = flags['server-path']
      } else { // TODO: Add support for ssh
        // User didn't specify a way to save the file. Ask them.
        const { saveChoice }: { saveChoice: 'root' | 'world' | 'server-path' } = await inquirer.prompt({
          name: 'saveChoice',
          type: 'list',
          message: 'Where do you want your pack(s) to be saved (can be changed later)?',
          choices: [{
            name: 'In the root client (.minecraft) folder',
            value: 'root',
            short: 'Client folder',
          }, {
            name: 'In a world',
            value: 'world',
            short: 'World',
          }, {
            name: 'In a server',
            value: 'server-path',
            short: 'Server path',
          }],
        })

        if (saveChoice === 'root') {
          saveOptions.root = true
        } else if (saveChoice === 'world') {
          const { world }: { world: string } = await inquirer.prompt({
            name: 'World',
            message: 'What world do you want to save the packs in? >',
            type: 'list',
            choices: getWorldsList,
          })
          saveOptions.world = world
        } else { // TODO: Add native folder selector
          const { serverPath }: { serverPath: string } = await inquirer.prompt({
            name: 'Server path',
            message: 'Where is the server to save the packs in? Relative paths are accepted. >',
            type: 'input',
          })

          saveOptions.serverPath = serverPath
        }
      }
      if (flags['client-path']) {
        saveOptions.clientPath = flags['client-path']
      }
    }

    let useYarn = flags.yarn
    if (!flags.yarn && !flags.npm && hasYarn()) {
      useYarn = (await inquirer.prompt({
        name: 'useYarn',
        message: 'What package manager do you want to use? >',
        type: 'list',
        choices: ['npm', 'yarn'],
      })).useYarn === 'yarn'
    }

    fs.mkdirSync(projectPath)

    // Create project & install dependencies
    this.log(chalk`Installing {rgb(229,193,0) sandstone@${sandstoneVersion[0]}}, {rgb(229,193,0) sandstone-cli@${sandstoneVersion[1]}} and {cyan typescript} using {cyan ${useYarn ? 'yarn' : 'npm'}}.`)

    const exec = (cmd: string) => execSync(cmd, { cwd: projectPath })

    exec('git clone https://github.com/sandstone-mc/sandstone-template.git .')

    exec(`git checkout ${projectType}-${sandstoneVersion[0]}`)

    exec('rm -rf .git')

    exec(`${useYarn ? 'yarn' : 'npm'} install`)

    // TODO: Make profiles for either packs or libraries

    const configPath = path.join(projectPath, `${projectType === 'library' ? 'test/' : ''}sandstone.config.ts`)

    // Merge with the config values
    let templateConfig = await fs.readFile(configPath, 'utf8')

    if (projectType === 'pack') {
      templateConfig.replace(`name: 'template'`, `name: ${toJson(packName)}`)

      templateConfig.replace(`namespace: 'default'`, `namespace: ${toJson(namespace)}`)
    } else {
      templateConfig.replace(`name: 'template'`, `name: ${toJson(`${projectName}-testing`)}`)
    }

    // TODO: packFormat

    const opts = toJson(Object.fromEntries(Object.entries(saveOptions).filter(([_, value]) => value !== undefined)))

    if (opts !== '{}') {
      templateConfig = templateConfig.replace('saveOptions: {}', `saveOptions: ${opts}`)
    }

    // Rewrite config
    fs.writeFileSync(configPath, templateConfig)

    const prefix = useYarn ? 'yarn' : 'npm run'
    this.log(chalk`{green Success!} Created "${projectName}" at "${projectPath}"`)

    this.log('Inside that directory, you can run several commands:\n')
    this.log(chalk`  {cyan ${prefix} build}:\n    Builds the packs. {cyan ⛏}\n`)
    this.log(chalk`  {cyan ${prefix} watch}:\n    Builds the packs, and rebuilds on each file change. {cyan ⛏}\n`)

    this.log('We suggest that you begin by typing:\n')
    this.log(chalk`  {cyan cd} ${projectName}\n  {cyan ${prefix} watch}`)
  }
}
