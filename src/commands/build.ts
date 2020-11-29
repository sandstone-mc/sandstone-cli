import { Command, flags } from '@oclif/command'
import nodemon from 'nodemon'
import path from 'path'
import util from 'util'
import { BuildOptions, buildProject } from '../buildProject'
import Watch from './watch'

export default class Build extends Command {
  static description = 'Build the datapack, and rebuild it on file change. ⛏'

  static examples = [
    '$ sand build',
    '$ sand build --verbose',
    '$ sand build --verbose --dry',
  ]

  static flags = Watch.flags

  static args = Watch.args

  async run() {
    const { args, flags } = this.parse(Build)

    // Ensure ts-node is ON
    require('ts-node/register')

    buildProject(flags)
  }
}