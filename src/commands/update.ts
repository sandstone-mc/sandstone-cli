import { Command, flags } from '@oclif/command'
import inquirer from 'inquirer'
import ncu from 'npm-check-updates'
import chalk from 'chalk'
import { execSync } from 'child_process'
import { hasYarn } from '../utils'
import fs from 'fs-extra'

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

    const updates = await ncu.run({
      filter: ['sandstone', 'sandstone-cli']
    })
    const sandstoneNewVersion = updates.sandstone
    const cliNewVersion = updates['sandstone-cli']

    if (sandstoneNewVersion) {
      console.log(chalk`{rgb(229,193,0) Sandstone} has a new version available: {greenBright ${sandstoneNewVersion}}`)
    } else {
      console.log(chalk`{rgb(229,193,0) Sandstone} is already up to date!`)
    }
    if (cliNewVersion) {
      console.log(chalk`{rgb(229,193,0) Sandstone-CLI} has a new version available: {greenBright ${cliNewVersion}}`)
    } else {
      console.log(chalk`{rgb(229,193,0) Sandstone-CLI} is already up to date!`)
    }


    let updateSandstone = flags.sandstone && sandstoneNewVersion
    if (sandstoneNewVersion && !updateSandstone && !flags.skip) {
      updateSandstone = (await inquirer.prompt({
        name: 'updateSandstone',
        message: chalk`Update Sandstone to {greenBright ${sandstoneNewVersion}}? >`,
        type: 'confirm',
      })).updateSandstone
    }

    let updateCli = flags.cli && cliNewVersion
    if (cliNewVersion && !updateCli && !flags.skip) {
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

    if (updateSandstone) {
      if (useYarn) {
        execSync('yarn add sandstone@latest')
      }
      else {
        execSync('npm install sandstone@latest')
      }
    }

    if (updateCli) {
      if (useYarn) {
        execSync('yarn add --dev sandstone-cli@latest')
      }
      else {
        execSync('npm install --save-dev sandstone-cli@latest')
      }
    }
  }
}
