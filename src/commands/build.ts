
import { register as tsEval } from 'ts-node'
import path from 'path'

import { getProjectFolders } from '../utils.js'
import { buildProject } from '../build/index.js'

type BuildOptions = {
    // Flags
    dry?: boolean
    verbose?: boolean
    root?: boolean
    fullTrace?: boolean
    strictErrors?: boolean
    production?: boolean
  
    // Values
    path: string,
    configPath: string,
    name?: string
    namespace?: string
    world?: string
    clientPath?: string
    serverPath?: string

    ssh?: any,

    dependencies?: [string, string][]
}

export async function buildCommand(opts: BuildOptions) {
    const folders = getProjectFolders(opts.path)

    tsEval({
      transpileOnly: !opts.strictErrors,
      project: path.join(folders.rootFolder, 'tsconfig.json'),
    })

    buildProject(opts, folders)
}