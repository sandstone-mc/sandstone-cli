import { Command, flags } from '@oclif/command'
import chalk from 'chalk'
import { execSync } from 'child_process'
import fs from 'fs'
import fsExtra from 'fs-extra'
import inquirer from 'inquirer'
import path from 'path'
import util from 'util'
import templatePackage from '../package.template.json'
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
    'pack-name': flags.string({ char: 'd', env: 'PACK_NAME', description: 'The name of the data pack.' }),
    namespace: flags.string({ char: 'n', env: 'NAMESPACE', description: 'The default namespace that will be used.' }),
    'save-root': flags.boolean({ char: 'r', env: 'SAVE_ROOT', description: 'Save the data pack & resource pack in the .minecraft/datapacks & .minecraft/resource_packs folders. Not compatible with --world.', exclusive: ['world'] }),
    world: flags.string({ char: 'w', env: 'WORLD', description: 'The world to save the packs in. Not compatible with --save-root or --server', exclusive: ['save-root', 'server'] }),
    'server-path': flags.string({ char: 's', env: 'SERVER_PATH', description: 'The server path to write the server-side packs at. Not compatible with --world.', exclusive: ['world'] }),
    'client-path': flags.string({ char: 'c', env: 'CLIENT_PATH', description: 'The client path to write packs at.' }),
  }

  static args = [{
    name: 'project-name',
    description: 'Name of the project folder. This is not the name of the data pack.',
    required: true,
  }]

  async run() {
    const { args, flags } = this.parse(Create)

    const projectPath = path.resolve(args['project-name'])
    const projectName = path.basename(projectPath)

    const packName = await getFlagOrPrompt(flags, 'pack-name', {
      message: 'Name of your data pack (can be changed later) >',
      type: 'input',
      default: projectName,
    })

    // Find the save directory
    const saveOptions: {
      root?: boolean | undefined
      world?: string | undefined
      serverPath?: string | undefined
      clientPath?: string | undefined
    } = {}

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
        message: 'Where do you want your packs to be saved (can be changed later)?',
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

    const namespace = await getFlagOrPrompt(flags, 'namespace', {
      message: 'Default namespace (can be changed later) >',
      default: 'default',
    })

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
    this.log(chalk`Installing {rgb(229,193,0) sandstone}, {rgb(229,193,0) sandstone-cli} and {cyan typescript} using {cyan ${useYarn ? 'yarn' : 'npm'}}.`)

    if (useYarn) {
      /** Init the package, skipping the interactive prompt */
      execSync('yarn init --yes', { cwd: projectPath })

      /** Install dependencies */
      execSync('yarn add sandstone', { cwd: projectPath })
      execSync('yarn add --dev typescript @types/node sandstone-cli', { cwd: projectPath })
    } else {
      /** Init the package, skipping the interactive prompt */
      execSync('npm init --yes', { cwd: projectPath })

      /** Install dependencies */
      execSync('npm install sandstone', { cwd: projectPath })
      execSync('npm install --save-dev typescript @types/node sandstone-cli', { cwd: projectPath })
    }

    // TODO: Make profiles for either packs or libraries

    // Merge with the package.json template
    const generatedPackage = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json')).toString())

    /** Remove the `main` property */
    const {main: _, ...newPackage} = { ...generatedPackage, ...templatePackage } as Record<string, string>

    // Rewrite package.json
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify(newPackage, null, 2))

    // Add files from template
    const templateFolder = path.join(__dirname, '../template/')

    await fsExtra.copy(templateFolder, projectPath)

    // Write the sandstone.json file
    fs.writeFileSync(path.join(projectPath, 'sandstone.config.ts'),
    `import type { SandstoneConfig } from 'sandstone'

export default {
  name: ${toJson(packName)},
  packs: {
    datapack: {
      description: ${toJson(['A ', {text: 'Sandstone', color: 'gold'}, ' data pack.'])},
      packFormat: ${11},
    }
  },
  namespace: ${toJson(namespace)},
  packUid: ${toJson(nanoid(8))},
  saveOptions: ${toJson(Object.fromEntries(Object.entries(saveOptions).filter(([_, value]) => value !== undefined)))},
  onConflict: {
    default: 'warn',
  },
} as SandstoneConfig
`)

    const prefix = useYarn ? 'yarn' : 'npm run'
    this.log(chalk`{green Success!} Created "${projectName}" at "${projectPath}"`)

    this.log('Inside that directory, you can run several commands:\n')
    this.log(chalk`  {cyan ${prefix} build}:\n    Builds the data pack. {cyan ⛏}\n`)
    this.log(chalk`  {cyan ${prefix} watch}:\n    Builds the data pack, and rebuild on each file change. {cyan ⛏}\n`)

    this.log('We suggest that you begin by typing:\n')
    this.log(chalk`  {cyan cd} ${projectName}\n  {cyan ${prefix} watch}`)
  }
}
