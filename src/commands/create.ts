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
    '$ sand create my-datapack',
  ]

  static flags = {
    help: flags.help({ char: 'h' }),
    yarn: flags.boolean({ description: 'Use yarn instead of npm.', env: 'USE_YARN', exclusive: ['npm'] }),
    npm: flags.boolean({ description: 'Use npm.', env: 'USE_NPM', exclusive: ['yarn'] }),
    'datapack-name': flags.string({ char: 'd', env: 'DATAPACK_NAME', description: 'The name of the data pack.' }),
    namespace: flags.string({ char: 'n', env: 'NAMESPACE', description: 'The default namespace that will be used.' }),
    'save-root': flags.boolean({ char: 'r', env: 'SAVE_ROOT', description: 'Save the data pack in the .minecraft/datapacks folder. Not compatible with --world and --custom-path.', exclusive: ['world', 'custom-path'] }),
    world: flags.string({ char: 'w', env: 'WORLD', description: 'The world to save the data pack in. Not compatible with --save-root and --custom-path.', exclusive: ['save-root', 'custom-path'] }),
    'custom-path': flags.string({ char: 'p', env: 'CUSTOM_PATH', description: 'The path to save the data pack at. Not compatible with --save-root and --world.', exclusive: ['save-root', 'world'] }),
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

    const datapackName = await getFlagOrPrompt(flags, 'datapack-name', {
      message: 'Name of your data pack (can be changed later) >',
      type: 'input',
      default: projectName,
    })

    // Find the save directory
    const saveOptions: {
      root?: boolean | undefined
      world?: string | undefined
      path?: string | undefined
    } = {}

    if (flags['save-root']) {
      saveOptions.root = true
    } else if (flags.world) {
      saveOptions.world = flags.world
    } else if (flags['custom-path']) {
      saveOptions.path = flags['custom-path']
    } else {
      // User didn't specify a way to save the file. Ask him.
      const { saveChoice }: { saveChoice: 'root' | 'world' | 'custom' } = await inquirer.prompt({
        name: 'saveChoice',
        type: 'list',
        message: 'Where do you want your datapack to be saved (can be changed later)?',
        choices: [{
          name: 'In the root .minecraft/datapacks folder',
          value: 'root',
          short: '.minecraft/datapacks folder',
        }, {
          name: 'In the datapacks folder of a world',
          value: 'world',
          short: 'World datapacks folder',
        }, {
          name: 'At a custom path',
          value: 'path',
          short: 'Custom path',
        }],
      })

      if (saveChoice === 'root') {
        saveOptions.root = true
      } else if (saveChoice === 'world') {
        const { world }: { world: string } = await inquirer.prompt({
          name: 'world',
          message: 'What world do you want to save the Datapack in? >',
          type: 'list',
          choices: getWorldsList,
        })
        saveOptions.world = world
      } else {
        const { path }: { path: string } = await inquirer.prompt({
          name: 'path',
          message: 'Where do you want to save the data pack? Relative paths are accepted. >',
          type: 'input',
        })

        saveOptions.path = path
      }
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
    
    if (fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory()) {
      const { overwrite }: { overwrite: string } = await inquirer.prompt({
        name: 'overwrite',
        message: 'The project directory you specified already exists, so some files might be changed/overwritten. Do you want to continue?',
        type: 'list',
        choices: ['Yes', 'No']
      });
      if (overwrite !== 'Yes') return;
    } else { 
      fs.mkdirSync(projectPath)
    }

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
  name: ${toJson(datapackName)},
  description: ${toJson(['A ', {text: 'Sandstone', color: 'gold'}, ' data pack.'])},
  formatVersion: ${6},
  namespace: ${toJson(namespace)},
  packUid: ${toJson(nanoid(8))},
  saveOptions: ${toJson(Object.fromEntries(Object.entries(saveOptions).filter(([_, value]) => value !== undefined)))}
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
