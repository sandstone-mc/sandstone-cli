#!/usr/bin/env node
import { Argument, Command } from 'commander';
import figlet from 'figlet';
import { createCommand } from './commands/index.js';
import { BuildDeclares } from './shared.js';

const commander = new Command()

console.log(figlet.textSync('Sandstone'));

const createCLI = commander
  .version('1.0.0')
  .description('Create a new Sandstone project. ⛏')
  .action(createCommand)
  .addArgument(new Argument('<projectName>', 'Not the name of the output pack'))

createCLI.option.apply(createCLI, BuildDeclares.name)
  .option.apply(createCLI, BuildDeclares.namespace)
  .option.apply(createCLI, BuildDeclares.world)
  .option.apply(createCLI, BuildDeclares.clientPath)
  .option.apply(createCLI, BuildDeclares.serverPath)


createCLI.parse(process.argv)