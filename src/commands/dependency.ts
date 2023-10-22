import fs from 'fs-extra'
import path from 'path'
import { buildCommand } from './build.js'

export async function installNativeCommand() {
  console.log('unimplemented')
}
export async function installVanillaCommand(_libraries: string[]) {
  let libraries = _libraries

  let count = libraries?.length || 0

  if (count === 0) {
    // do thing
  }

  if (count > 0) {
    let manifest: Record<string, string> | false = false
    try {
      manifest = JSON.parse(await fs.readFile(path.resolve('./resources/smithed.json'), 'utf-8'))
    } catch (e) {}

    let adding: [string, string][] | false = false

    for (const library of libraries) {
      const version = library.includes('@') ? library.split('@')[1] : 'latest'

      if (!manifest || !(manifest[library] || manifest[library] === version)) {
        if (!adding) adding = []
        adding.push([library, version])
      } else {
        count--
      }
    }
    if (adding) {
      console.log(await buildCommand({
        path: './src',
        configPath: './',
        dependencies: adding
      }))
    }

    console.log(`${count} libraries added`)
  }
}

export async function uninstallNativeCommand() {
  console.log('unimplemented')
}

export async function uninstallVanillaCommand(opts: { libraries: string[] }) {}

export async function refreshCommand() {}