import fs from 'fs-extra'
import path from 'path'
import { exec } from 'child_process'
import { buildCommand } from './build.js'
import inquirer from 'inquirer'

const _fetch = import('node-fetch')

type LibraryManifest = {
  libraries: {
    name: string,
    package: string,
  }[]
}

export async function installNativeCommand(_libraries: string[]) {
  let libraries: [string, boolean][] = _libraries.map((lib) => [lib, false])

  let count = libraries.length || 0

  const fetch = (await _fetch).default

  const manifest = await (await fetch('https://raw.githubusercontent.com/sandstone-mc/sandstone-libraries/main/manifest.json')).json() as LibraryManifest

  const search = async () => {
    const { selected } = await inquirer.prompt({
      name: 'selected',
      type: 'checkbox',
      message: 'Which libraries to add?',
      choices: manifest.libraries.map((library) => ({
        name: library.name,
        value: library.package,
      })),
    }) as {
      selected: string[]
    }

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

      const pnpm = await fs.exists(path.resolve('./pnpm-lock.yaml'))
      const yarn = await fs.exists(path.resolve('./yarn.lock'))
      const npm = await fs.exists(path.resolve('./package-lock.json'))

      if (pnpm) {
        exec(`pnpm i ${adding.join(' ')}`)
      } else if (yarn) {
        exec(`yarn add ${adding.join(' ')}`)
      } else if (npm) {
        exec(`npm i ${adding.join(' ')}`)
      } else {
        console.error('error: no package manager lockfile')
      }
    }
  }
}

type SmithedSearch = { 
  id: string,
  displayName: string,
  data: { display: { description: string } },
  meta: { rawId: string, stats: { downloads: { total: number } }, owner: string }
  owner: { displayName: string }
}[]

export async function installVanillaCommand(_libraries: string[]) {
  let libraries: [string, boolean][] = _libraries.map((lib) => [lib, false])

  let count = libraries.length || 0

  let manifest: Record<string, string> | false = false
  try {
    manifest = JSON.parse(await fs.readFile(path.resolve('./resources/smithed.json'), 'utf-8'))
  } catch (e) {}

  const fetch = (await _fetch).default
  const base = 'https://api.smithed.dev/v2'

  const search = async (term?: string) => {
    const options = []

    const optionColumn = [0, 0, 0]

    const scopes = ['data.display.description', 'meta.rawId', 'meta.stats.downloads.total', 'owner.displayName'].map((scope) => `scope=${scope}`).join('&')

    for await (const { id, displayName, meta, data, owner } of (await (await fetch(`${base}/packs?category=Library&sort=downloads&${scopes}${term ? `&search=${encodeURIComponent(term)}` : ''}`)).json() as SmithedSearch)) {

      const option = {
        id: meta.rawId,
        name: displayName,
        owner: owner.displayName,
        downloads: `${meta.stats.downloads.total}`,
        description: data.display.description,
      }

      if (manifest && !manifest[id] && !manifest[meta.rawId]) {
        
        if (option.name.length > optionColumn[0]) optionColumn[0] = option.name.length

        if (option.owner.length > optionColumn[1]) optionColumn[1] = option.owner.length
        
        if (option.downloads.length > optionColumn[2]) optionColumn[2] = option.downloads.length

        options.push(option)
      }
    }

    const space = (index: number, option: string) => {
      const length = optionColumn[index] - option.length

      let _space = ''

      for (let i = 0; i < length; i++) {
        _space += ' '
      }

      return  `${_space} - `
    }

    if (options.length === 0) {
      console.log('No results found!')
    } else {
      const { selected } = await inquirer.prompt({
        name: 'selected',
        type: 'checkbox',
        message: 'Which libraries to add?',
        choices: options.map((option) => ({
          name: `${option.name}${space(0, option.name)}by ${option.owner}${space(1, option.owner)}${option.downloads} downloads${space(2, option.downloads)}${option.description}`,
          short: `${option.name} - by ${option.owner} - ${option.downloads} downloads - ${option.description}`,
          value: [option.id, true],
        })),
      }) as {
        selected: [string, true][]
      }
  
      if (selected && selected.length !== 0) {
        libraries.push(...selected)
  
        count += selected.length
  
        return true
      }
    }
    return false
  }

  if (count === 0) {
    await search()
  }

  if (count > 0) {

    let adding: [string, string][] | false = false

    for await (const [library, searched] of libraries) {
      const version = library.includes('@') ? library.split('@')[1] : 'latest'

      if (!manifest || !(manifest[library] || manifest[library] === version)) {
        if (searched) {
          if (!adding) adding = []
          adding.push([library, version])
        } else {
          let exists = false
          try {
            /* @ts-ignore */
            exists = (await (await fetch(`${base}/packs/${library}/meta`)).json()).statusCode !== 404
          } catch (e) {}

          if (exists) {
            if (!adding) adding = []
            adding.push([library, version])
          } else {
            count--

            console.log(`${library} doesn't exist! Searching...`)

            if (await search(library)) {
              if (!adding) adding = []
            }
          }
        }
      } else {
        count--
      }
    }
    if (adding) {
      await buildCommand({
        path: './src',
        configPath: './',
        dependencies: adding
      })
    }
  }

  console.log
  console.log(`${count} libraries added`)
}

export async function uninstallVanillaCommand(_libraries: string[]) {
  const libraries = _libraries || []

  let count = libraries.length || 0

  let manifestPath = path.resolve('./resources/smithed.json')

  let manifest: Record<string, string> | false = false

  let lockFilePath = path.resolve('./resources/cache/lock-smithed.json')

  let lockFile: Record<string, {}> | false = false

  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    lockFile = JSON.parse(await fs.readFile(lockFilePath, 'utf-8'))
  } catch (e) {}

  if (manifest) {
    if (count === 0) {
      const { selected } = await inquirer.prompt({
        name: 'selected',
        type: 'checkbox',
        message: 'Which libraries to remove?',
        choices: Object.entries(manifest).map(([name]) => ({
          short: name,
          value: name,
        })),
      }) as {
        selected: string[]
      }

      if (selected && selected.length !== 0) {
        count = selected.length

        libraries.push(...selected)
      }
    }
  
    if (count > 0) {
      for await (const library of libraries) {
        if (manifest[library]) {
          delete manifest[library]

          await fs.remove(path.resolve(`./resources/cache/smithed/${library}`))

          if (lockFile) {
            delete lockFile[library]
          }
        } else {
          count--
        }
      }
      await fs.writeFile(manifestPath, JSON.stringify(manifest))

      if (lockFile) {
        await fs.writeFile(lockFilePath, JSON.stringify(lockFile))
      }
    } 
  } else {
    console.error('error: no dependency manifest')
  }

  if (count === 0 && manifest) {
    console.log('Libraries not found, installed libraries:')
    Object.entries(manifest).forEach(([lib]) => console.log(lib))
  }

  console.log(`${count} libraries removed`)
}

export async function refreshCommand() {
  let lockFilePath = path.resolve('./resources/cache/lock-smithed.json')

  let lockFile: Record<string, {}> | false = false

  try {
    lockFile = JSON.parse(await fs.readFile(lockFilePath, 'utf-8'))
  } catch (e) {}

  if (lockFile) {
    console.log('Refreshing libraries...')

    await fs.remove(path.resolve('./resources/cache/smithed'))

    await fs.writeFile(lockFilePath, '{}')

    await buildCommand({
      path: './src',
      configPath: './'
    })
  } else {
    console.log('No libraries to refresh')
  }
}