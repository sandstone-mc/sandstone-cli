import { Command, flags } from '@oclif/command'
import inquirer from 'inquirer'
import chalk from 'chalk'
import { execSync } from 'child_process'
import { getFileFolder, getProjectFolders, hasYarn } from '../utils'
import fs from 'fs-extra'
import path from 'path'
import semver from 'semver'

export default class Watch extends Command {
  static description = 'Update Sandstone & Sandstone-CLI.'

  static examples = [
    '$ sand update',
    '$ sand update --cli',
    '$ sand update --sandstone',
    '$ sand update --cli --sandstone --skip',
  ]

  static flags = {
    help: flags.help({ char: 'h' }),
    cli: flags.boolean({ description: 'Update the Sandstone CLI without asking.' }),
    sandstone: flags.boolean({ description: 'Update the current Sandstone version without asking.' }),
    skip: flags.boolean({ description: 'Skip all interactive prompts and refuse them.' }),
    yarn: flags.boolean({ description: 'Use yarn to install the updates.', exclusive: ['npm'] }),
    npm: flags.boolean({ description: 'Use npm to install the updates.', exclusive: ['yarn'] }),
  }

  static args = []

  async run() {
    const { args, flags } = this.parse(Watch)
    
    // First, check if there are any update
    console.log('Checking for updates...')

    const rootFolder = getFileFolder('package.json', '.')
    if (!rootFolder) {
      console.error(chalk`{red Failed to find {bold package.json} in ${path.resolve()}, or in any parent folder.}`)
      return
    }

    let npmListReturn
    try {
      npmListReturn = execSync('npm list --depth 0 --json --silent', {
        cwd: rootFolder,
      }).toString()
    }
    catch ({ stdout }) {
      npmListReturn = (stdout as any).toString()
    }

    const { dependencies } = JSON.parse(npmListReturn)

    const sandstoneOldVersion = dependencies?.sandstone?.version ?? dependencies?.sandstone?.required?.version
    const cliOldVersion = dependencies?.['sandstone-cli']?.version ?? dependencies?.['sandstone-cli']?.required?.version

    const sandstoneNewVersion = execSync('npm view sandstone version').toString().trim()
    const cliNewVersion = execSync('npm view sandstone-cli version').toString().trim()

    const sandstoneNeedsUpdate = sandstoneOldVersion && semver.lt(sandstoneOldVersion, sandstoneNewVersion)
    const cliNeedsUpdate = cliOldVersion && semver.lt(cliOldVersion, cliNewVersion)

    if (sandstoneNeedsUpdate) {
      console.log(chalk`{rgb(229,193,0) Sandstone} has a new version available: {greenBright ${sandstoneNewVersion}} {gray (current: ${sandstoneOldVersion})}`)
    } else {
      console.log(chalk`{rgb(229,193,0) Sandstone} is already up to date!`)
    }
    if (cliNeedsUpdate) {
      console.log(chalk`{rgb(229,193,0) Sandstone-CLI} has a new version available: {greenBright ${cliNewVersion}} {gray (current: ${cliOldVersion})}`)
    } else {
      console.log(chalk`{rgb(229,193,0) Sandstone-CLI} is already up to date!`)
    }


    let updateSandstone = flags.sandstone && sandstoneNeedsUpdate
    if (sandstoneNeedsUpdate && !updateSandstone && !flags.skip) {
      updateSandstone = (await inquirer.prompt({
        name: 'updateSandstone',
        message: chalk`Update Sandstone to {greenBright ${sandstoneNewVersion}}? >`,
        type: 'confirm',
      })).updateSandstone
    }

    let updateCli = flags.cli && cliNeedsUpdate
    if (cliNeedsUpdate && !updateCli && !flags.skip) {
      updateCli = (await inquirer.prompt({
        name: 'updateCli',
        message: chalk`Update CLI to {greenBright ${cliNewVersion}}? >`,
        type: 'confirm',
      })).updateCli
    }

    if (!updateSandstone && !updateCli) {
      return
    }

    
    let useYarn = flags.yarn || (fs.existsSync('yarn.lock') && hasYarn() && !flags.npm)
    if (!useYarn && !flags.npm && hasYarn() && !fs.existsSync('package-lock.json')) {
      useYarn = (await inquirer.prompt({
        name: 'useYarn',
        message: 'What package manager do you want to use? >',
        type: 'list',
        choices: ['npm', 'yarn'],
      })).useYarn === 'yarn'
    }

    const installationMessage = [
      updateSandstone ? 'sandstone' : null,
      updateCli ? 'sandstone-cli' : null,
    ].filter(msg => msg !== null)
     .map(msg => chalk.rgb(299,193,0)(msg))
     .join(', ')
    
    this.log(chalk`Installing ${installationMessage} using {cyan ${useYarn ? 'yarn' : 'npm'}}.`)

    if (updateCli) {
      if (useYarn) {
        execSync('yarn add --dev sandstone-cli@latest')
      }
      else {
        execSync('npm install --save-dev sandstone-cli@latest')
      }

      const { onSandstoneUpdate } = require('../onUpdate')
      onSandstoneUpdate(sandstoneOldVersion, sandstoneNewVersion)
    }

    if (updateSandstone) {
      if (useYarn) {
        execSync('yarn add sandstone@latest')
      }
      else {
        execSync('npm install sandstone@latest')
      }

      const { onCliUpdate } = require('../onUpdate')
      onCliUpdate(cliOldVersion, cliNewVersion)
    }

  }
}
