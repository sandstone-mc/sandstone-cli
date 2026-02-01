import { SemVer } from 'semver'
import fs from 'fs-extra'
import path from 'path'
import chalk from 'chalk-template'
import util from 'util'
import * as child from 'child_process'
import { nanoid } from 'nanoid'
import { confirm, select, input } from '@inquirer/prompts'

import { capitalize, getWorldsList, hasBun, hasPnpm, hasYarn } from '../utils.js'

type CreateOptions = {
  // Flags
  root: boolean

  // Values
  world?: string
  clientPath?: string
  serverPath?: string
  // TODO: ssh
}

function toJson(obj: any, pretty = false): string {
  return util.inspect(obj, {
    depth: Number(Infinity),
    colors: false,
    breakLength: Number(Infinity),
    compact: !pretty,
    maxArrayLength: Number(Infinity),
  })
}

export async function createCommand(_project: string, opts: CreateOptions) {

  const projectPath = path.resolve(_project)
  const projectName = path.basename(projectPath)

  const projectType = (await confirm({
    message: 'Whether your project will be a library for use in other Sandstone projects >',
    default: false,
  })) === true ? 'library' : 'pack'

  const sv = (v: string) => new SemVer(v)

  const versions = [[sv('0.13.6'), sv('0.5.4')], [sv('1.0.0-beta.0'), sv('1.1.11')]] as const

  const version = await select({
    message: 'Which version of Sandstone do you want to use? These are the only supported versions for new projects.',
    choices: versions.map((v) => {
      const { prerelease, major, minor } = v[0]

      const release = `${major}.${minor}`

      return {
        name: prerelease.length === 0 ?
          `Release Version ${release}` :
          `${capitalize(prerelease[0] as string)} Version ${prerelease[1]} for release ${release}`,
        value: v,
        short: v[0].toString(),
      }
    }),
    default: versions[0],
  })

  let packName = projectName

  let namespace = projectName.replace(RegExp(/ /g), '_')

  if (projectType === 'pack') {
    packName = (await input({
      message: 'Name of your output pack(s) (can be changed later) >',
      default: projectName,
    }))

    namespace = (await input({
      message: 'Default namespace (can be changed later) >',
      default: namespace,
    }))
  } else {
    packName += '-testing'
    namespace += '_test'
  }

  // Find the save directory
  const saveOptions: {
    root?: boolean | undefined
    world?: string | undefined
    serverPath?: string | undefined
    clientPath?: string | undefined
  } = {}

  if (version[0].major === 1) {
    if (opts.clientPath) {
      saveOptions.clientPath = opts.clientPath
    }

    if (opts.root) {
      saveOptions.root = true
    } else if (opts.world) {
      saveOptions.world = opts.world
    } else if (opts.serverPath) {
      saveOptions.serverPath = opts.serverPath
    } else { // TODO: Add support for ssh
      // User didn't specify a way to save the file. Ask them.
      const saveChoice = await select<'root' | 'world' | 'server-path' | 'none'>({
        message: 'Where do you want your pack(s) to be exported to (can be changed later)?',
        choices: [{
          name: 'In the root client (.minecraft/datapacks & .minecraft/resourcepacks) folder(s)',
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
        }, {
          name: 'N/A',
          value: 'none',
          short: 'None',
        }],
      })

      switch (saveChoice) {
        case 'root':
          saveOptions.root = true
          break
        case 'world':
          const world = await select({
            message: 'What world do you want to save the packs in? >',
            choices: getWorldsList(saveOptions.clientPath),
          })
          saveOptions.world = world
          break
        case 'server-path':
          const serverPath = await input({
            message: 'Where is the server to save the packs in? Relative paths are accepted. >',
          })

          saveOptions.serverPath = serverPath
          break
        case 'none': break
      }
    }
  }

  let packageManager = 'npm'

  const yarn = hasYarn()
  const pnpm = hasPnpm()
  const bun =  hasBun()

  if (yarn || pnpm) {
    const choices = ['npm']

    if (yarn) choices.unshift('yarn')
    if (pnpm) choices.unshift('pnpm')
    if (bun)  choices.unshift('bun')

    packageManager = (await select({
      message: 'What package manager do you want to use? >',
      choices: choices
    }))
  }

  fs.mkdirSync(projectPath)

  // Create project & install dependencies
  console.log(chalk`Installing {rgb(229,193,0) sandstone@${version[0]}}, {rgb(229,193,0) sandstone-cli@${version[1]}} and {cyan typescript} using {cyan ${packageManager}}.`)

  const exec = (cmd: string) => child.execSync(cmd, { cwd: projectPath })

  exec('git clone https://github.com/sandstone-mc/sandstone-template.git .')

  exec(`git checkout ${projectType}-${version[0]}`)

  exec('npx rimraf -rf .git')

  exec(`${packageManager} install`)

  const configPath = path.join(projectPath, `${projectType === 'library' ? 'test/' : ''}sandstone.config.ts`)

  // Merge with the config values
  let templateConfig = await fs.readFile(configPath, 'utf8')

  templateConfig = templateConfig.replace('packUid: \'kZZpDK67\'', `packUid: ${toJson(nanoid(8))}`)

  templateConfig = templateConfig.replace('name: \'template\'', `name: ${toJson(packName)}`)

  templateConfig = templateConfig.replace('namespace: \'default\'', `namespace: ${toJson(namespace)}`)

  // TODO: packFormat

  const optsJson = toJson(Object.fromEntries(Object.entries(saveOptions).filter(([_, value]) => value !== undefined)))

  if (optsJson !== '{}') {
    templateConfig = templateConfig.replace('saveOptions: {}', `saveOptions: ${optsJson}`)
  }

  // Rewrite config
  fs.writeFileSync(configPath, templateConfig)

  const prefix = packageManager === 'npm' ? 'npm run' : packageManager
  console.log(chalk`{green Success!} Created "${projectName}" at "${projectPath}"`)

  console.log('Inside that directory, you can run several commands:\n')
  console.log(chalk`  {cyan ${prefix} build}:\n    Builds the packs. {cyan ⛏}\n`)
  console.log(chalk`  {cyan ${prefix} watch}:\n    Builds the packs, and rebuilds on each file change. {cyan ⛏}\n`)

  console.log('We suggest that you begin by typing:\n')
  console.log(chalk`  {cyan cd} ${projectName}\n  {cyan ${prefix} watch}`)
} 