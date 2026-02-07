import { Argument, Command } from 'commander'
import figlet from 'figlet'
import { buildCommand, createCommand, watchCommand, installNativeCommand, installVanillaCommand, uninstallVanillaCommand, refreshCommand } from './commands/index.js'
import { BuildDeclares } from './shared.js'

const commander = new Command()

console.log(figlet.textSync('Sandstone'));

const CLI = commander
  .version('1.0.0')
  .description('The CLI for Sandstone - the minecraft pack creation library.')

const build = CLI
  .command('build')
  .description('Build the pack(s). ⛏')

build.option.apply(build, BuildDeclares.dry)
  .option.apply(build, BuildDeclares.verbose)
  .option.apply(build, BuildDeclares.root)
  .option.apply(build, BuildDeclares.fullTrace)
  .option.apply(build, BuildDeclares.strictErrors)
  .option.apply(build, BuildDeclares.production)

  .option.apply(build, BuildDeclares.path)
  .option.apply(build, BuildDeclares.name)
  .option.apply(build, BuildDeclares.namespace)
  .option.apply(build, BuildDeclares.world)
  .option.apply(build, BuildDeclares.clientPath)
  .option.apply(build, BuildDeclares.serverPath)

  .option.apply(build, BuildDeclares.enableSymlinks)
  .action(buildCommand)

const watch = CLI
  .command('watch')
  .description('Build the packs, and rebuild them on file change. ⛏')
  .action(watchCommand)

watch.option.apply(watch, BuildDeclares.dry)
  .option.apply(watch, BuildDeclares.verbose)
  .option.apply(watch, BuildDeclares.root)
  .option.apply(watch, BuildDeclares.fullTrace)
  .option.apply(watch, BuildDeclares.strictErrors)

  .option.apply(watch, BuildDeclares.path)
  .option.apply(watch, BuildDeclares.name)
  .option.apply(watch, BuildDeclares.namespace)
  .option.apply(watch, BuildDeclares.world)
  .option.apply(watch, BuildDeclares.clientPath)
  .option.apply(watch, BuildDeclares.serverPath)

  .option.apply(watch, BuildDeclares.library)
  .option.apply(watch, BuildDeclares.manual)
  .option.apply(watch, BuildDeclares.enableSymlinks)

const create = CLI
  .command('create')
  .description('Create a new Sandstone project. ⛏')
  .action(createCommand)
  .addArgument(new Argument('<projectName>', 'Not the name of the output pack'))

create.option.apply(create, BuildDeclares.name)
  .option.apply(create, BuildDeclares.namespace)
  .option.apply(create, BuildDeclares.world)
  .option.apply(create, BuildDeclares.clientPath)
  .option.apply(create, BuildDeclares.serverPath)

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