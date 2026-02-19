import { SemVer } from 'semver'
import fs from 'fs-extra'
import path from 'path'
import chalk from 'chalk-template'
import util from 'util'
import * as child from 'child_process'
import { nanoid } from 'nanoid'
import { confirm, select, input } from '@inquirer/prompts'

import { CLI_VERSION } from '../version.js'
import { capitalize, getWorldsList, hasBun, hasPnpm, hasYarn } from '../utils.js'
import { discoverAllInstances, type MinecraftInstance } from '../launchers/index.js'

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

/** Parse Minecraft version from metadata (not from name) */
function parseVersion(version: string | undefined): number[] | null {
  if (!version) return null
  // Match version patterns like 1.21.6, 1.20
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (match) {
    return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3] || '0')]
  }
  // Snapshot format like 24w12a
  const snapshotMatch = version.match(/^(\d+)w(\d+)/)
  if (snapshotMatch) {
    return [1, parseInt(snapshotMatch[1]), parseInt(snapshotMatch[2])]
  }
  return null
}

/** Compare two version arrays (descending - newer first) */
function compareVersions(a: number[] | null, b: number[] | null): number {
  if (!a && !b) return 0
  if (!a) return 1  // null versions go to end
  if (!b) return -1
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return b[i] - a[i]  // descending
  }
  return 0
}

/** Prompt user to select a Minecraft installation from detected instances */
async function selectClientInstance(): Promise<string | undefined> {
  const { instances } = await discoverAllInstances()

  if (instances.length === 0) {
    return await input({ message: 'No Minecraft installations detected. Enter path to .minecraft folder:' })
  }

  // Separate vanilla from other instances
  const vanilla = instances.find(i => i.launcher === 'vanilla')
  const otherInstances = instances.filter(i => i.launcher !== 'vanilla')

  // Sort by version metadata (newest first), then alphabetically by name
  otherInstances.sort((a, b) => {
    const versionCmp = compareVersions(parseVersion(a.version), parseVersion(b.version))
    if (versionCmp !== 0) return versionCmp
    return a.name.localeCompare(b.name)
  })

  type ChoiceValue = MinecraftInstance | 'none' | 'custom'
  const choices: Array<{ name: string; value: ChoiceValue; short: string }> = []

  // Add Custom and None at top
  choices.push({ name: 'Custom path...', value: 'custom', short: 'Custom' })
  choices.push({ name: 'None (configure later)', value: 'none', short: 'None' })

  // Add Vanilla (default)
  if (vanilla) {
    choices.push({
      name: `${vanilla.name} [${vanilla.launcher}]`,
      value: vanilla,
      short: vanilla.name,
    })
  }

  // Add sorted instances (newest version first)
  for (const i of otherInstances) {
    choices.push({
      name: `${i.name}${i.version ? ` (${i.version})` : ''} [${i.launcher}]`,
      value: i,
      short: i.name,
    })
  }

  const selected = await select({
    message: 'Select Minecraft installation:',
    choices,
    default: vanilla ?? 'none',  // Vanilla is default, or None if Vanilla not present
  })

  if (selected === 'none') {
    return undefined
  }
  if (selected === 'custom') {
    return await input({ message: 'Enter path to .minecraft folder:' })
  }
  return selected.minecraftPath
}

export async function createCommand(_project: string, opts: CreateOptions) {

  const projectPath = path.resolve(_project)
  const projectName = path.basename(projectPath)

  const projectType = (await confirm({
    message: 'Whether your project will be a library for use in other Sandstone projects >',
    default: false,
  })) === true ? 'library' : 'pack'

  const sv = (v: string) => new SemVer(v)

  const versions = [[sv('1.0.0-beta.2'), sv(CLI_VERSION)]] as const

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
        case 'root': {
          const clientPath = await selectClientInstance()
          if (clientPath) {
            saveOptions.clientPath = clientPath
          }
          saveOptions.root = true
          break
        }
        case 'world': {
          const clientPath = await selectClientInstance()
          if (clientPath) {
            saveOptions.clientPath = clientPath
          }
          const world = await select({
            message: 'What world do you want to save the packs in? >',
            choices: getWorldsList(saveOptions.clientPath),
          })
          saveOptions.world = world
          break
        }
        case 'server-path': {
          const serverPath = await input({
            message: 'Where is the server to save the packs in? Relative paths are accepted. >',
          })
          saveOptions.serverPath = serverPath
          break
        }
        case 'none': break
      }
    }
  }

  let packageManager = 'npm'

  const yarn = hasYarn()
  const pnpm = hasPnpm()
  const bun =  hasBun()

  if (yarn || pnpm || bun) {
    const choices = ['npm']

    if (yarn) choices.unshift('yarn')
    if (pnpm) choices.unshift('pnpm')
    if (bun)  choices.unshift('bun')

    packageManager = (await select({
      message: 'What package manager do you want to use? (For now you have to use Bun) >',
      choices: choices
    }))
  }

  fs.mkdirSync(projectPath)

  // Create project & install dependencies
  console.log(chalk`Installing {rgb(229, 193, 0) sandstone@${version[0]}}, {rgb(229, 193, 0) sandstone-cli@${version[1]}} and {cyan typescript} using {cyan ${packageManager}}.`)

  const exec = (cmd: string) => child.execSync(cmd, { cwd: projectPath })

  exec('git clone https://github.com/sandstone-mc/sandstone-template.git .')

  exec(`git checkout ${projectType}-${version[0]}`)

  await fs.rm(path.join(projectPath, '.git'), { force: true, recursive: true })

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
  console.log(chalk`  {cyan ${prefix} dev:build}:\n    Builds the packs. {cyan ⛏}\n`)
  console.log(chalk`  {cyan ${prefix} dev:watch}:\n    Builds the packs, and rebuilds on each file change. {cyan ⛏}\n`)

  console.log('We suggest that you begin by typing:\n')
  console.log(chalk`  {cyan cd} ${projectName}\n  {cyan ${prefix} dev:watch}`)
} 