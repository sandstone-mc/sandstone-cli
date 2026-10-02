#!/usr/bin/env bun
import { Argument, Command } from 'commander'
import chalk from 'chalk-template'

import { CLI_VERSION } from './version.js'
import { buildCommand, createCommand, watchCommand, installNativeCommand, cleanCommand, linkCommand, unlinkCommand, connectCommand, runCommand, testCommand, mcpCommand } from './commands/index.js'
import { BuildOptions } from './utils/commander.js'

if (Bun.which('bun') === null) {
  console.error(chalk`{red Error:} Sandstone CLI requires {cyan Bun} (>= 1.1) to run.`)
  console.error(chalk`Install Bun: {cyan https://bun.com}`)
  process.exit(1)
}

const commander = new Command()

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
  .addOption(BuildOptions.get('test'))
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
  .description('Install Native Sandstone or Vanilla libraries. ⛏')
install
  .command('native')
  .description('Install Native Sandstone libraries. ⛏')
  .action(installNativeCommand)
  .addArgument(new Argument('[libraries...]', 'Optional. Libraries to install. When unlisted, a selector will appear.'))
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

CLI
  .command('connect')
  .description('Start (or shut down) a long-lived host daemon that exposes the chosen provider over WebSocket. Endpoint file lives at <project>/.sandstone/connect.url. ⛏')
  .addOption(BuildOptions.get('path'))
  .addOption(BuildOptions.get('hostType'))
  .addOption(BuildOptions.get('hostConfig'))
  .addOption(BuildOptions.get('hostConfigFile'))
  .addOption(BuildOptions.get('bind'))
  .addOption(BuildOptions.get('port'))
  .addOption(BuildOptions.get('shutdown'))
  .addOption(BuildOptions.get('deploy'))
  .addOption(BuildOptions.get('restartServer'))
  .action(connectCommand)

CLI
  .command('run')
  .description('Run Minecraft console commands on the configured server. By default sends a single raw command (e.g. "op MulverineX"). If the argument ends in `.mcfunction`, runs each non-empty, non-comment line in order (a trailing `\\` joins lines). If the argument ends in `.ts`, dynamically imports the file, calls its `export default function`, and runs the Sandstone commands it emits (a single connection is reused for the whole batch). Uses the live `sand connect` daemon if one is running, otherwise connects directly. With `--expect`, waits up to `--timeout` seconds for a log line matching the regex; applies to the LAST emitted command in file mode. ⛏')
  .addHelpText('after', `
Examples:
  $ sand run "op MulverineX"
  $ sand run scripts/welcome.mcfunction
  $ sand run scripts/test.ts --expect "Welcome, .*")

If the .ts script creates any child resource (a nested MCFunction,
Advancement, Recipe, Tag, …), sand run throws — only inline commands
are supported. Use \`sand build\` to write resources to disk.`)
  .addOption(BuildOptions.get('path'))
  .addOption(BuildOptions.get('hostType'))
  .addOption(BuildOptions.get('hostConfig'))
  .addOption(BuildOptions.get('hostConfigFile'))
  .addOption(BuildOptions.get('expect'))
  .addOption(BuildOptions.get('timeout'))
  .action((commandAndArgs: string[], opts: { path: string; hostType?: string; hostConfig?: string; hostConfigFile?: string; expect?: string; timeout?: string }) => runCommand(opts, commandAndArgs))
  .addArgument(new Argument('<command...>', 'A console command (e.g. "op MulverineX", "say Hello"), or a path to a .mcfunction / .ts file.'))

CLI
  .command('test')
  .description('Run GameTests on the configured server via `test run *:*`. Attaches to the server log before running and parses every failure report emitted between `Running test environment` and `Game Test complete!`. Uses the same connection machinery as `sand run`. Exits 0 when no required failures occurred, 1 when at least one required test failed (or the closing marker was never seen). Optional failures (level WARN, marked `(optional)`) do not trigger a non-zero exit. ⛏')
  .addHelpText('after', `
Examples:
  $ sand test

Requires the datapack to define GameTests (each test class registered via
\`SandstoneTest\`; use \`sand build --test\` to opt them into the build).
The CLI exits non-zero when any required test fails so it can be wired
into CI as a drop-in check.`)
  .addOption(BuildOptions.get('path'))
  .addOption(BuildOptions.get('hostType'))
  .addOption(BuildOptions.get('hostConfig'))
  .addOption(BuildOptions.get('hostConfigFile'))
  .action(testCommand)

CLI
  .command('mcp')
  .description('Start a stdio MCP server exposing the project state (resources + tools) to LLM agents. Speak JSON-RPC over stdio per the Model Context Protocol spec. Designed to be invoked by an MCP-aware host (Claude Code, Cursor, etc.) as a subprocess. ⛏')
  .addHelpText('after', `
Examples:
  # Register with Claude Code:
  $ claude mcp add sandstone-cli sand mcp -- --path /abs/path/to/project

  # Run ad-hoc (talks JSON-RPC over stdio):
  $ sand mcp --path .

Logging output goes to stderr (never stdout) so the MCP protocol on
stdout stays valid.`)
  .addOption(BuildOptions.get('path'))
  .action(mcpCommand)


CLI.parse(process.argv)