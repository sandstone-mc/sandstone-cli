#!/usr/bin/env bun
import { Argument, Command } from 'commander'
import figlet from 'figlet'

import { CLI_VERSION } from './version.js'
import { buildCommand, createCommand, watchCommand, installNativeCommand, installVanillaCommand, uninstallVanillaCommand, refreshCommand } from './commands/index.js'
import { BuildOptions } from './shared.js'

const commander = new Command()

console.log(figlet.textSync('Sandstone'));

const CLI = commander
  .version(CLI_VERSION, '-v, --version')
  .description('The CLI for Sandstone - the minecraft pack creation library.')

CLI
  .command('build')
  .description('Build the pack(s). ⛏')
  .addOption(BuildOptions.get('dry'))
  .addOption(BuildOptions.get('verbose'))
  .addOption(BuildOptions.get('root'))
  .addOption(BuildOptions.get('fullTrace'))
  .addOption(BuildOptions.get('strictErrors'))
  .addOption(BuildOptions.get('production'))
  .addOption(BuildOptions.get('path'))
  .addOption(BuildOptions.get('name'))
  .addOption(BuildOptions.get('namespace'))
  .addOption(BuildOptions.get('world'))
  .addOption(BuildOptions.get('clientPath'))
  .addOption(BuildOptions.get('serverPath'))
  .action(buildCommand)

CLI
  .command('watch')
  .description('Build the packs, and rebuild them on file change. ⛏')
  .addOption(BuildOptions.get('dry'))
  .addOption(BuildOptions.get('verbose'))
  .addOption(BuildOptions.get('root'))
  .addOption(BuildOptions.get('fullTrace'))
  .addOption(BuildOptions.get('strictErrors'))
  .addOption(BuildOptions.get('path'))
  .addOption(BuildOptions.get('name'))
  .addOption(BuildOptions.get('namespace'))
  .addOption(BuildOptions.get('world'))
  .addOption(BuildOptions.get('clientPath'))
  .addOption(BuildOptions.get('serverPath'))
  .addOption(BuildOptions.get('library'))
  .addOption(BuildOptions.get('manual'))
  .addOption(BuildOptions.get('ignore'))
  .action(watchCommand)

CLI
  .command('create')
  .description('Create a new Sandstone project. ⛏')
  .addOption(BuildOptions.get('name'))
  .addOption(BuildOptions.get('namespace'))
  .addOption(BuildOptions.get('world'))
  .addOption(BuildOptions.get('clientPath'))
  .addOption(BuildOptions.get('serverPath'))
  .action(createCommand)
  .addArgument(new Argument('<projectName>', 'Not the name of the output pack'))

const install = CLI
  .command('install')
  .alias('add')
  .alias('i')
  .description('Install Native Sandstone or Vanilla Smithed libraries. ⛏')
install
  .command('native')
  .description('Install Native Sandstone libraries. ⛏')
  .action(installNativeCommand)
  .addArgument(new Argument('[libraries...]', 'Optional. Libraries to install. When unlisted, a selector will appear.'))
install
  .command('vanilla')
  .alias('smithed')
  .description('Install Vanilla Smithed libraries. ⛏')
  .action(installVanillaCommand)
  .addArgument(new Argument('[libraries...]', 'Optional. Libraries to install. When unlisted, a selector will appear.'))

CLI
  .command('uninstall')
  .alias('remove')
  .description('Uninstall Vanilla Smithed libraries. ⛏')
  .action(uninstallVanillaCommand)
  .addArgument(new Argument('[libraries...]', 'Optional. Libraries to uninstall. When unlisted, a selector will appear.'))

CLI
  .command('refresh')
  .description('Clear & update cached Smithed libraries. ⛏')
  .action(refreshCommand)


CLI.parse(process.argv)