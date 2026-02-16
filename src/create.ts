#!/usr/bin/env bun
import { Argument, Command } from 'commander'
import figlet from 'figlet'

import { CLI_VERSION } from './version.js'
import { createCommand } from './commands/create.js'
import { BuildOptions } from './shared.js'

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