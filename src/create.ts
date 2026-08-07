#!/usr/bin/env bun
import { Argument, Command } from 'commander'
import chalk from 'chalk-template'
import figlet from 'figlet'

import { CLI_VERSION } from './version.js'
import { createCommand } from './commands/create.js'
import { BuildOptions } from './utils/commander.js'

if (Bun.which('bun') === null) {
  console.error(chalk`{red Error:} Sandstone CLI requires {cyan Bun} (>= 1.1) to run.`)
  console.error(chalk`Install Bun: {cyan https://bun.com}`)
  process.exit(1)
}

const commander = new Command()

console.log(figlet.textSync('Sandstone'));

commander
  .version(CLI_VERSION)
  .description('Create a new Sandstone project. ⛏')
  .addOption(BuildOptions.get('name'))
  .addOption(BuildOptions.get('namespace'))
  .addOption(BuildOptions.get('world'))
  .addOption(BuildOptions.get('clientPath'))
  .addOption(BuildOptions.get('serverPath'))
  .action(createCommand)
  .addArgument(new Argument('<projectName>', 'Not the name of the output pack'))
  .parse(process.argv)