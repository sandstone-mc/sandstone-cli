#!/usr/bin/env bun
import { Argument, Command } from 'commander'
import chalk from 'chalk-template'
import figlet from 'figlet'

import { CLI_VERSION } from './version.js'
import { buildCommand, createCommand, watchCommand, installNativeCommand, installVanillaCommand, uninstallVanillaCommand, refreshCommand, cleanCommand, linkCommand, unlinkCommand } from './commands/index.js'
import { BuildOptions } from './utils/commander.js'

if (Bun.which('bun') === null) {
  console.error(chalk`{red Error:} Sandstone CLI requires {cyan Bun} (>= 1.1) to run.`)
  console.error(chalk`Install Bun: {cyan https://bun.com}`)
  process.exit(1)
}

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
  .addOption(BuildOptions.get('strictErrors'))
  .addOption(BuildOptions.get('production'))
  .addOption(BuildOptions.get('debug'))
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
  .command('clean')
  .description('Delete all external file/symlink locations sourced from saveOptions. Needed before upgrading a world, because Mojang refuses to upgrade worlds that contain symlinks. 🧹')
  .addHelpText('after', `
Removes the symlinks, copied folders, and exported .zip archives that
sandstone build placed outside of the project (e.g. inside a world's
datapacks/ folder, in .minecraft/resourcepacks, or in a server folder).
The next \`sand build\` will recreate them.

This is necessary before upgrading a Minecraft world to a newer version:
Mojang's world upgrade refuses to proceed while any symlink is present
inside the world's folder, even ones pointing at the pack on disk.`)
  .addOption(BuildOptions.get('path'))
  .addOption(BuildOptions.get('world'))
  .addOption(BuildOptions.get('clientPath'))
  .addOption(BuildOptions.get('serverPath'))
  .action(cleanCommand)

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

CLI
  .command('link')
  .description('Pack the current library (no args) or link a local library into this project. ⛏')
  .addOption(BuildOptions.get('path'))
  .action((libraryPath: string | undefined, opts: { path: string }) => linkCommand({ path: opts.path, libraryPath }))
  .addArgument(new Argument('[libraryPath]', 'Path to the library to link into this project. Omit to pack the current library.'))

CLI
  .command('unlink')
  .description('Unlink a library. With a target, removes the link from this project (restoring the previous version). Without a target, unpacks the current library. ⛏')
  .addOption(BuildOptions.get('path'))
  .action((target: string | undefined, opts: { path: string }) => unlinkCommand({ path: opts.path, target }))
  .addArgument(new Argument('[target]', 'Name or libraryPath to unlink from this project. Omit to unlink the current library.'))


CLI.parse(process.argv)