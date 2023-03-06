sandstone-cli
=============

The CLI for Sandstone - the datapack creation library.

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/sandstone-cli.svg)](https://npmjs.org/package/sandstone-cli)
[![Downloads/week](https://img.shields.io/npm/dw/sandstone-cli.svg)](https://npmjs.org/package/sandstone-cli)
[![License](https://img.shields.io/npm/l/sandstone-cli.svg)](https://github.com/TheMrZZ/sandstone-cli/blob/master/package.json)

<!-- toc -->
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g sandstone-cli
$ sand COMMAND
running command...
$ sand (-v|--version|version)
sandstone-cli/0.6.5 win32-x64 node-v16.15.0
$ sand --help [COMMAND]
USAGE
  $ sand COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [`sand build PATH CONFIG-PATH`](#sand-build-path-config-path)
* [`sand create PROJECT-NAME`](#sand-create-project-name)
* [`sand help [COMMAND]`](#sand-help-command)
* [`sand update`](#sand-update)
* [`sand watch PATH CONFIG-PATH`](#sand-watch-path-config-path)

## `sand build PATH CONFIG-PATH`

Build the packs. ⛏

```
USAGE
  $ sand build PATH CONFIG-PATH

ARGUMENTS
  PATH         [default: ./src] Path of the folder containing source files.
  CONFIG-PATH  [default: .] Path of the sandstone.config.ts folder.

OPTIONS
  -d, --dry                      Do not save the pack. Mostly useful with `verbose`.
  -h, --help                     show CLI help
  -p, --production               Runs Sandstone in production mode. This sets process.env.SANDSTONE_ENV to "production".
  -v, --verbose                  Log all resulting resources: functions, advancements...

  --autoReload=port              Automatically reload your datapack in-game. Requires to open the world to LAN with
                                 cheats enabled, and to specify the port.

  --clientPath=clientPath        Path of the client folder. Override the value specified in the configuration file.

  --description=description      Description of the datapack. Override the value specified in the configuration file.

  --formatVersion=formatVersion  Pack format version. Override the value specified in the configuration file.

  --fullTrace                    Show the full stack trace on errors.

  --name=name                    Name of the datapack. Override the value specified in the configuration file.

  --namespace=namespace          The default namespace. Override the value specified in the configuration file.

  --root                         Save the datapack & resource pack in the .minecraft/datapacks &
                                 .minecraft/resource_packs folders. Override the value specified in the configuration
                                 file.

  --serverPath=serverPath        Path of the server folder. Override the value specified in the configuration file.

  --strictErrors                 Stop datapack compilation on type errors.

  --world=world                  The world to save the datapack in. Override the value specified in the configuration
                                 file.

EXAMPLES
  $ sand build
  $ sand build --verbose
  $ sand build --verbose --dry
```

_See code: [src/commands/build.ts](https://github.com/TheMrZZ/sandstone-cli/blob/v0.6.5/src/commands/build.ts)_

## `sand create PROJECT-NAME`

Create a new Sandstone project.

```
USAGE
  $ sand create PROJECT-NAME

ARGUMENTS
  PROJECT-NAME  Name of the project folder. This is not the name of the output pack(s).

OPTIONS
  -c, --client-path=client-path  The client path to write packs at.
  -d, --pack-name=pack-name      The name of the pack(s).
  -h, --help                     show CLI help
  -n, --namespace=namespace      The default namespace that will be used.

  -r, --save-root                Save the datapack & resource pack in the .minecraft/datapacks &
                                 .minecraft/resource_packs folders. Not compatible with --world.

  -s, --server-path=server-path  The server path to write the server-side packs at. Not compatible with --world.

  -t, --library                  Whether the project will be a library for use in other Sandstone projects.

  -v, --version=version          What version of Sandstone you'd like to create a project for.

  -w, --world=world              The world to save the packs in. Not compatible with --save-root or --server

  --npm                          Use npm.

  --yarn                         Use yarn instead of npm.

EXAMPLE
  $ sand create my-pack
```

_See code: [src/commands/create.ts](https://github.com/TheMrZZ/sandstone-cli/blob/v0.6.5/src/commands/create.ts)_

## `sand help [COMMAND]`

display help for sand

```
USAGE
  $ sand help [COMMAND]

ARGUMENTS
  COMMAND  command to show help for

OPTIONS
  --all  see all commands in CLI
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v3.2.1/src/commands/help.ts)_

## `sand update`

Update Sandstone & Sandstone-CLI.

```
USAGE
  $ sand update

OPTIONS
  -h, --help   show CLI help
  --cli        Update the Sandstone CLI without asking.
  --npm        Use npm to install the updates.
  --sandstone  Update the current Sandstone version without asking.
  --skip       Skip all interactive prompts and refuse them.
  --yarn       Use yarn to install the updates.

EXAMPLES
  $ sand update
  $ sand update --cli
  $ sand update --sandstone
  $ sand update --cli --sandstone --skip
```

_See code: [src/commands/update.ts](https://github.com/TheMrZZ/sandstone-cli/blob/v0.6.5/src/commands/update.ts)_

## `sand watch PATH CONFIG-PATH`

Build the packs, and rebuild them on file change. ⛏

```
USAGE
  $ sand watch PATH CONFIG-PATH

ARGUMENTS
  PATH         [default: ./src] Path of the folder containing source files.
  CONFIG-PATH  [default: .] Path of the sandstone.config.ts folder.

OPTIONS
  -d, --dry                      Do not save the pack. Mostly useful with `verbose`.
  -h, --help                     show CLI help
  -p, --production               Runs Sandstone in production mode. This sets process.env.SANDSTONE_ENV to "production".
  -v, --verbose                  Log all resulting resources: functions, advancements...

  --autoReload=port              Automatically reload your datapack in-game. Requires to open the world to LAN with
                                 cheats enabled, and to specify the port.

  --clientPath=clientPath        Path of the client folder. Override the value specified in the configuration file.

  --description=description      Description of the datapack. Override the value specified in the configuration file.

  --formatVersion=formatVersion  Pack format version. Override the value specified in the configuration file.

  --fullTrace                    Show the full stack trace on errors.

  --name=name                    Name of the datapack. Override the value specified in the configuration file.

  --namespace=namespace          The default namespace. Override the value specified in the configuration file.

  --root                         Save the datapack & resource pack in the .minecraft/datapacks &
                                 .minecraft/resource_packs folders. Override the value specified in the configuration
                                 file.

  --serverPath=serverPath        Path of the server folder. Override the value specified in the configuration file.

  --strictErrors                 Stop datapack compilation on type errors.

  --world=world                  The world to save the datapack in. Override the value specified in the configuration
                                 file.

EXAMPLES
  $ sand watch
  $ sand watch --verbose
  $ sand watch --verbose --dry
```

_See code: [src/commands/watch.ts](https://github.com/TheMrZZ/sandstone-cli/blob/v0.6.5/src/commands/watch.ts)_
<!-- commandsstop -->
