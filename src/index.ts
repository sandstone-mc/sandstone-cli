import { Argument, Command } from 'commander';
import figlet from 'figlet';
import { buildCommand, createCommand, watchCommand } from './commands/index.js';

const commander = new Command()

console.log(figlet.textSync('Sandstone'));

const CLI = commander
  .version('1.0.0')
  .description('The CLI for Sandstone - the minecraft pack creation library.')

const BuildDeclares = {
  // Flags
  dry: ['-d, --dry', 'Do not save the pack. Mostly useful with `verbose`.'],
  verbose: ['-v, --verbose', 'Log all resulting resources: functions, advancements...'],
  root: ['-r, --root', 'Save the pack & resource pack in the .minecraft/datapacks & .minecraft/resource_packs folders. Override the value specified in the configuration file.'],
  fullTrace: ['-t, --full-trace', 'Show the full stack trace on errors.'],
  strictErrors: ['-s, --strict-errors', 'Stop pack compilation on type errors.'],
  production: ['-p, --production', 'Runs Sandstone in production mode. This sets process.env.SANDSTONE_ENV to "production".'],

  // Values
  path: ['--path <path>', 'Path of the folder containing source files.', './src'],
  config: ['--config-path', 'Path of the sandstone.config.ts folder.', './'],
  name: ['-n, --name <name>', 'Name of the datapack. Override the value specified in the configuration file.'],
  namespace: ['-ns, --namespace <namespace>', 'The default namespace. Override the value specified in the configuration file.'],
  world: ['-w, --world <name>', 'The name of the world to save the packs in. Override the value specified in the configuration file.'],
  clientPath: ['-c, --client-path <path>', 'Path of the client folder. Override the value specified in the configuration file.'],
  serverPath: ['--server-path <path>', 'Path of the server folder. Override the value specified in the configuration file.'],
  // TODO: ssh
  // TODO: reimplement auto reload
} as unknown as Record<string, [string, string, RegExp, boolean]> // Haha TypeScript funny

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
  .option.apply(build, BuildDeclares.config)
  .option.apply(build, BuildDeclares.name)
  .option.apply(build, BuildDeclares.namespace)
  .option.apply(build, BuildDeclares.world)
  .option.apply(build, BuildDeclares.clientPath)
  .option.apply(build, BuildDeclares.serverPath)
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
  .option.apply(watch, BuildDeclares.config)
  .option.apply(watch, BuildDeclares.name)
  .option.apply(watch, BuildDeclares.namespace)
  .option.apply(watch, BuildDeclares.world)
  .option.apply(watch, BuildDeclares.clientPath)
  .option.apply(watch, BuildDeclares.serverPath)

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

// TODO
/*CLI
  .command('update')
  .description('Update Sandstone & Sandstone-CLI.. ⛏')
  .action(updateCommand)*/


CLI.parse(process.argv)