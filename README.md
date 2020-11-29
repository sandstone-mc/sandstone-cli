sandstone-cli
=============

The CLI for Sandstone - the data pack creation library.

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
sandstone-cli/0.1.1 win32-x64 node-v14.15.0
$ sand --help [COMMAND]
USAGE
  $ sand COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [`sand build`](#sand-build)
* [`sand create PROJECT-NAME`](#sand-create-project-name)
* [`sand help [COMMAND]`](#sand-help-command)
* [`sand watch`](#sand-watch)

## `sand build`

```
USAGE
  $ sand build

OPTIONS
  -d, --dry                      Do not save the datapack. Mostly useful with `verbose`.
  -h, --help                     show CLI help
  -v, --verbose                  Log all resulting resources: functions, advancements...
  --description=description      Description of the data pack. Override the value specified in the configuration file.
  --formatVersion=formatVersion  Pack format version. Override the value specified in the configuration file.
  --minecraftPath=minecraftPath  Path of the .minecraft folder. Override the value specified in the configuration file.
  --name=name                    Name of the data pack. Override the value specified in the configuration file.
  --namespace=namespace          The default namespace. Override the value specified in the configuration file.

  --path=path                    The path to save the data pack at. Override the value specified in the configuration
                                 file.

  --root                         Save the data pack in the `.minecraft/datapacks` folder. Override the value specified
                                 in the configuration file.

  --world=world                  The world to save the data pack in. Override the value specified in the configuration
                                 file.

EXAMPLES
  $ sand build
  $ sand build --verbose
  $ sand build --verbose --dry
```

_See code: [src/commands/build.ts](https://github.com/TheMrZZ/sandstone-cli/blob/v0.1.1/src/commands/build.ts)_

## `sand create PROJECT-NAME`

```
USAGE
  $ sand create PROJECT-NAME

ARGUMENTS
  PROJECT-NAME  Name of the project folder. This is not the name of the data pack.

OPTIONS
  -d, --datapack-name=datapack-name  The name of the data pack.
  -h, --help                         show CLI help
  -n, --namespace=namespace          The default namespace that will be used.
  -p, --custom-path=custom-path      The path to save the data pack at. Not compatible with --save-root and --world.

  -r, --save-root                    Save the data pack in the .minecraft/datapacks folder. Not compatible with --world
                                     and --custom-path.

  -w, --world=world                  The world to save the data pack in. Not compatible with --save-root and
                                     --custom-path.

  --npm                              Use npm.

  --yarn                             Use yarn instead of npm.

EXAMPLE
  $ sand create my-datapack
```

_See code: [src/commands/create.ts](https://github.com/TheMrZZ/sandstone-cli/blob/v0.1.1/src/commands/create.ts)_

## `sand help [COMMAND]`

```
USAGE
  $ sand help [COMMAND]

ARGUMENTS
  COMMAND  command to show help for

OPTIONS
  --all  see all commands in CLI
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v3.2.0/src/commands/help.ts)_

## `sand watch`

```
USAGE
  $ sand watch

OPTIONS
  -d, --dry                      Do not save the datapack. Mostly useful with `verbose`.
  -h, --help                     show CLI help
  -v, --verbose                  Log all resulting resources: functions, advancements...
  --description=description      Description of the data pack. Override the value specified in the configuration file.
  --formatVersion=formatVersion  Pack format version. Override the value specified in the configuration file.
  --minecraftPath=minecraftPath  Path of the .minecraft folder. Override the value specified in the configuration file.
  --name=name                    Name of the data pack. Override the value specified in the configuration file.
  --namespace=namespace          The default namespace. Override the value specified in the configuration file.

  --path=path                    The path to save the data pack at. Override the value specified in the configuration
                                 file.

  --root                         Save the data pack in the `.minecraft/datapacks` folder. Override the value specified
                                 in the configuration file.

  --world=world                  The world to save the data pack in. Override the value specified in the configuration
                                 file.

EXAMPLES
  $ sand watch
  $ sand watch --verbose
  $ sand watch --verbose --dry
```

_See code: [src/commands/watch.ts](https://github.com/TheMrZZ/sandstone-cli/blob/v0.1.1/src/commands/watch.ts)_
<!-- commandsstop -->
