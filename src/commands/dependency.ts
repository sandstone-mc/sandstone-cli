import path from 'path'
import { checkbox } from '@inquirer/prompts'

import * as fs from '../utils/fs.js'
import { run } from '../utils/shell.js'

type LibraryManifest = {
  libraries: {
    name: string,
    package: string,
  }[]
}

export async function installNativeCommand(_libraries: string[]) {
  let libraries: [string, boolean][] = _libraries.map((lib) => [lib, false])

  let count = libraries.length || 0

  const manifest = await (await fetch('https://raw.githubusercontent.com/sandstone-mc/sandstone-libraries/main/manifest.json')).json() as LibraryManifest

  if (manifest.libraries.length === 0) {
    console.error('error: no native libraries are available')
  } else {
    const search = async () => {
      const selected = await checkbox({
        message: 'Which libraries to add?',
        choices: manifest.libraries.map((library) => ({
          name: library.name,
          value: library.package,
        })),
      })

      if (selected && selected.length !== 0) {
        libraries.push(...selected.map((lib) => [lib, true] as [string, boolean]))

        count += selected.length
      }
    }

    if (count === 0) {
      await search()
    }

    if (count > 0) {
      let adding: string[] | false = false

      for await (const [library, searched] of libraries) {
        if (searched) {
          if (!adding) adding = []
          adding.push(library)
        } else {
          let exists = manifest.libraries.find((lib) => lib.name === library)

          if (exists) {
            if (!adding) adding = []
            adding.push(exists.package)
          } else {
            count--

            console.log(`${library} doesn't exist!`)
          }
        }
      }
      if (adding) {
        console.log(`Installing ${adding.join(', ')}...`)

        // Fire-and-forget install via the shell wrapper. Each branch shells
        // out to the user's package manager; we don't await stdout because
        // the spawn wrapper already runs with stdio='inherit' when configured
        // for the `run` helper's interactive form. Here we just want the side
        // effect to happen.
        const cwd = path.resolve('.')
        if (await fs.fileExists(path.resolve('./bun.lock'))) {
          await run('bun', ['i', ...adding], { cwd, throws: false })
        } else if (await fs.fileExists(path.resolve('./pnpm-lock.yaml'))) {
          console.error('error: node is not currently supported, use bun instead')
        } else if (await fs.fileExists(path.resolve('./yarn.lock'))) {
          console.error('error: node is not currently supported, use bun instead')
        } else if (await fs.fileExists(path.resolve('./package-lock.json'))) {
          console.error('error: node is not currently supported, use bun instead')
        } else {
          console.error('error: no package manager lockfile')
        }
      }
    }
  }
}
