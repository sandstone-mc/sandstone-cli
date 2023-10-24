
import path from 'path'
import { fork } from 'child_process'
import { ProjectFolders, getProjectFolders } from '../utils.js'

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

export function buildCommand(opts: BuildOptions, _folders?: ProjectFolders) {
  const folders = _folders?.projectFolder ? _folders : getProjectFolders(opts.path)

  console.log('Compiling source...\n')

  const build = fork(path.join(folders.rootFolder, 'node_modules', 'sandstone-build', 'lib', 'index.js'), process.argv.slice(2), {
    stdio: 'pipe',
    env: {
      NODE_OPTIONS: "--loader ts-node/esm",
      CLI_OPTIONS: JSON.stringify(opts),
      PROJECT_FOLDERS: JSON.stringify(folders),
    }
  })

  let esmErrored = false

  build?.stdout?.on('data', (data) => process.stdout.write(data))

  build?.stderr?.on('data', (data) => {
    if (esmErrored) {
      process.stderr.write(data)
    } else {
      esmErrored = true
    }
  })

  return new Promise<void>((resolve) => {
    build?.stdout?.on('end', () => resolve())
  })
}