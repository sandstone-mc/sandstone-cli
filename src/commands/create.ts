import { SemVer } from 'semver'
import path from 'path'
import chalk from 'chalk-template'
import util from 'util'
import { nanoid } from 'nanoid'
import { confirm, select, input } from '@inquirer/prompts'

import { CLI_VERSION } from '../version.js'
import { getWorldsList, hasBun, hasPnpm, hasYarn } from '../utils/index.js'
import * as fs from '../utils/fs.js'
import { sh } from '../utils/shell.js'
import { getAvailableSandstoneVersions } from './versionDiscovery.js'
import { discoverAllInstances, vanillaProvider, type MinecraftInstance } from '../launchers/index.js'

type CreateOptions = {
  // Flags
  root: boolean

  // Values
  world?: string
  clientPath?: string
  serverPath?: string
  // TODO: ssh
}

function toJson(obj: any, pretty = false): string {
  return util.inspect(obj, {
    depth: Number(Infinity),
    colors: false,
    breakLength: Number(Infinity),
    compact: !pretty,
    maxArrayLength: Number(Infinity),
  })
}

/** Parse Minecraft version from metadata (not from name) */
function parseVersion(version: string | undefined): number[] | null {
  if (!version) return null
  // Match version patterns like 1.21.6, 1.20
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (match) {
    return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3] || '0')]
  }
  // Snapshot format like 24w12a
  const snapshotMatch = version.match(/^(\d+)w(\d+)/)
  if (snapshotMatch) {
    return [1, parseInt(snapshotMatch[1]), parseInt(snapshotMatch[2])]
  }
  return null
}

/** Compare two version arrays (descending - newer first) */
function compareVersions(a: number[] | null, b: number[] | null): number {
  if (!a && !b) return 0
  if (!a) return 1  // null versions go to end
  if (!b) return -1
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return b[i] - a[i]  // descending
  }
  return 0
}

/**
 * Resolve a Minecraft client path: ask the user via `selectClientInstance`,
 * then fall back to the vanilla provider when the selection is empty
 * (user picked "None" or submitted a blank custom path). Returns the
 * resolved path, or throws if no installation is available anywhere.
 */
async function resolveClientPath(): Promise<string> {
  const selected = await selectClientInstance()
  if (selected) return selected

  const vanillaInstances = await vanillaProvider.discoverInstances()
  if (vanillaInstances.length > 0) return vanillaInstances[0].minecraftPath

  throw new Error(
    'No Minecraft installation selected and no vanilla .minecraft folder found. '
    + 'Install Minecraft once or re-run `sand create` and pick an instance.',
  )
}

/** Prompt user to select a Minecraft installation from detected instances */
async function selectClientInstance(): Promise<string | undefined> {
  const { instances } = await discoverAllInstances()

  if (instances.length === 0) {
    return await input({ message: 'No Minecraft installations detected. Enter path to .minecraft folder:' })
  }

  // Separate vanilla from other instances
  const vanilla = instances.find(i => i.launcher === 'vanilla')
  const otherInstances = instances.filter(i => i.launcher !== 'vanilla')

  // Sort by version metadata (newest first), then alphabetically by name
  otherInstances.sort((a, b) => {
    const versionCmp = compareVersions(parseVersion(a.version), parseVersion(b.version))
    if (versionCmp !== 0) return versionCmp
    return a.name.localeCompare(b.name)
  })

  type ChoiceValue = MinecraftInstance | 'none' | 'custom'
  const choices: Array<{ name: string; value: ChoiceValue; short: string }> = []

  // Add Custom and None at top
  choices.push({ name: 'Custom path...', value: 'custom', short: 'Custom' })
  choices.push({ name: 'None (configure later)', value: 'none', short: 'None' })

  // Add Vanilla (default)
  if (vanilla) {
    choices.push({
      name: `${vanilla.name} [${vanilla.launcher}]`,
      value: vanilla,
      short: vanilla.name,
    })
  }

  // Add sorted instances (newest version first)
  for (const i of otherInstances) {
    choices.push({
      name: `${i.name}${i.version ? ` (${i.version})` : ''} [${i.launcher}]`,
      value: i,
      short: i.name,
    })
  }

  const selected = await select({
    message: 'Select Minecraft installation:',
    choices,
    default: vanilla ?? 'none',  // Vanilla is default, or None if Vanilla not present
  })

  if (selected === 'none') {
    return undefined
  }
  if (selected === 'custom') {
    return await input({ message: 'Enter path to .minecraft folder:' })
  }
  return selected.minecraftPath
}

export async function createCommand(_project: string, opts: CreateOptions) {

  const projectPath = path.resolve(_project)
  const projectName = path.basename(projectPath)

  try {
    return await createCommandInner(_project, opts, projectPath, projectName)
  } catch (err) {
    // Match on `name` instead of `instanceof`: when the CLI is bundled,
    // `create.js` has its own copy of @inquirer/core's error classes,
    // so `instanceof ExitPromptError` returns false even when inquirer
    // itself threw one. See SBoudrias/Inquirer.js#1475 — the maintainer
    // recommends this exact pattern.
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'ExitPromptError') {
      // User force-closed a prompt (SIGINT, Ctrl+C). Bail with a clean
      // message instead of dumping the inquirer stack trace.
      console.log('\nCancelled.')
      process.exit(130)
    }
    throw err
  }
}

async function createCommandInner(
  _project: string,
  opts: CreateOptions,
  projectPath: string,
  projectName: string,
) {
  const projectType = (await confirm({
    message: 'Whether your project will be a library for use in other Sandstone projects >',
    default: false,
  })) === true ? 'library' : 'pack'

  const sv = (v: string) => new SemVer(v)

  // Per-minor release identifier. `version` is the concrete `${X}.{Y}.0`
  // SemVer used for installs + the `git checkout pack-X.Y.0` command
  // (SemVer ctor rejects `1.1.x`, and the template's branch tags are
  // always `pack-X.Y.0`). `short` is the display label (npm dist-tag
  // style: `1.1.x`).
  const minorTag = (info: typeof available[number]) => {
    const version = `${info.major}.${info.minor}.0`
    return { version, short: `${info.major}.${info.minor}.x` }
  }

  const available = await getAvailableSandstoneVersions()
  // npm dist-tag specifier per minor. The highest minor in the discovered
  // list is the current master and resolves to `latest`; any older minor
  // has been archived and ships its own `sandstone-{X}-{Y}` tag (e.g.
  // `sandstone-1-1`). When 1.3.x is released, 1.2.x gets archived and
  // automatically picks up `sandstone-1-2` — no CLI change needed.
  const currentMasterMinor = available[0]?.minor
  const versionChoices = available.map(
    (info): [SemVer, SemVer] => [sv(minorTag(info).version), sv(CLI_VERSION)]
  )

  const version = await select({
    message: 'Which version of Sandstone do you want to use?',
    choices: available.map((info, i) => {
      const tag = minorTag(info)
      return {
        name: `Release Version ${info.major}.${info.minor} (MC ${info.mcVersion})`,
        value: versionChoices[i]!,
        short: tag.short,
      }
    }),
    default: versionChoices[0],
  })

  let packName = projectName

  let namespace = projectName.replace(RegExp(/ /g), '_')

  // For libraries, the package name (and the linked dep in the test
  // workspace) needs to be unique so the library can be installed into
  // other projects by name. Suggest a scoped npm name by default — the
  // user can override with any valid npm package name.
  let libraryPackageName: string | undefined
  if (projectType === 'library') {
    const sanitized = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    const suggested = `@my-scope/${sanitized || 'my-library'}`
    libraryPackageName = await input({
      message: 'NPM package name for this library (scoped like @your-username/your-library is recommended, unscoped works too) >',
      default: suggested,
      validate: (v) => {
        if (!v) return 'Package name is required'
        if (v.length > 214) return 'Package name too long (max 214 chars)'
        // Same rules as npm: lowercase, no spaces, may have @scope/
        if (!/^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/.test(v)) {
          return 'Invalid npm package name (lowercase, may be @scope/name)'
        }
        return true
      },
    })
    packName += '-testing'
    namespace += '_test'
  } else {
    packName = (await input({
      message: 'Name of your output pack(s) (can be changed later) >',
      default: projectName,
    }))

    namespace = (await input({
      message: 'Default namespace (can be changed later) >',
      default: namespace,
    }))
  }

  // Find the save directory
  const saveOptions: {
    root?: boolean | undefined
    world?: string | undefined
    serverPath?: string | undefined
    clientPath?: string | undefined
  } = {}

  if (version[0].major === 1) {
    if (opts.clientPath) {
      saveOptions.clientPath = opts.clientPath
    }

    if (opts.root) {
      saveOptions.root = true
    } else if (opts.world) {
      saveOptions.world = opts.world
    } else if (opts.serverPath) {
      saveOptions.serverPath = opts.serverPath
    } else { // TODO: Add support for ssh
      // User didn't specify a way to save the file. Ask them.
      const saveChoice = await select<'root' | 'world' | 'server-path' | 'none'>({
        message: 'Where do you want your pack(s) to be exported to (can be changed later)?',
        choices: [{
          name: 'In the root client (.minecraft/datapacks & .minecraft/resourcepacks) folder(s)',
          value: 'root',
          short: 'Client folder',
        }, {
          name: 'In a world',
          value: 'world',
          short: 'World',
        }, {
          name: 'In a server',
          value: 'server-path',
          short: 'Server path',
        }, {
          name: 'N/A',
          value: 'none',
          short: 'None',
        }],
      })

      switch (saveChoice) {
        case 'root': {
          saveOptions.clientPath = await resolveClientPath()
          saveOptions.root = true
          break
        }
        case 'world': {
          saveOptions.clientPath = await resolveClientPath()
          const worlds = await getWorldsList(saveOptions.clientPath)
          if (worlds.length === 0) {
            console.log('\nNo worlds found in this installation\'s `saves/` folder.')
            console.log('Launch the instance in your launcher and create a world first, then re-run `sand create`.')
            console.log('Falling back to save at the instance root instead.\n')
            saveOptions.root = true
            break
          }
          const world = await select({
            message: 'What world do you want to save the packs in? >',
            choices: worlds,
          })
          saveOptions.world = world
          break
        }
        case 'server-path': {
          const serverPath = await input({
            message: 'Where is the server to save the packs in? Relative paths are accepted. >',
          })
          saveOptions.serverPath = serverPath
          break
        }
        case 'none': break
      }
    }
  }

  let packageManager = 'npm'

  const yarn = await hasYarn()
  const pnpm = await hasPnpm()
  const bun = await hasBun()

  if (yarn || pnpm || bun) {
    const choices = ['npm']

    if (yarn) choices.unshift('yarn')
    if (pnpm) choices.unshift('pnpm')
    if (bun)  choices.unshift('bun')

    packageManager = (await select({
      message: 'Pick your package manager',
      choices: choices
    }))
  }

  await fs.ensureDir(projectPath)

  // Create project & install dependencies
  // MC version for the selected minor (e.g. `26.2`). Found by matching the
  // picked SemVer back into the discovered list; majors are unique per
  // minor so a `(major, minor)` lookup is unambiguous.
  const selectedMcVersion = available.find(
    (v) => v.major === version[0].major && v.minor === version[0].minor,
  )?.mcVersion
  console.log(chalk`Installing {rgb(229, 193, 0) sandstone} for {green Minecraft ${selectedMcVersion}}, {rgb(229, 193, 0) sandstone-cli@${version[1]}} and {cyan typescript} using {cyan ${packageManager}}.`)

  await sh(`git clone -b ${projectType}-${version[0]} --single-branch https://github.com/sandstone-mc/sandstone-template.git .`, { cwd: projectPath, throws: true })

  await fs.remove(path.join(projectPath, '.git'), { force: true, recursive: true })

  // For libraries, rewrite the package.json files BEFORE installing so
  // the install picks up the new names. The template ships with
  // `name: "sandstone-template"` and a test workspace that links to it
  // via `link:sandstone-template`; both need to follow the user's
  // chosen package name or the workspace link will break.
  if (projectType === 'library' && libraryPackageName) {
    const rootPkgPath = path.join(projectPath, 'package.json')
    const rootPkg = JSON.parse(await fs.readText(rootPkgPath))
    const oldRootName = rootPkg.name
    rootPkg.name = libraryPackageName
    await fs.writeText(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n')

    const testPkgPath = path.join(projectPath, 'test', 'package.json')
    if (await fs.pathExists(testPkgPath)) {
      const testPkg = JSON.parse(await fs.readText(testPkgPath))
      testPkg.name = `${libraryPackageName}-test`
      // The test workspace links to the root via the package name; update
      // the dep spec so the link resolves to our renamed library.
      if (testPkg.dependencies?.[oldRootName]) {
        // The template ships with `link:sandstone-template`, which bun
        // resolves by the linked package's name. After renaming the
        // library, rewrite the link target to match so install succeeds.
        const oldSpec = testPkg.dependencies[oldRootName] as string
        const newSpec = oldSpec.replace(oldRootName, libraryPackageName)
        testPkg.dependencies[libraryPackageName] = newSpec
        delete testPkg.dependencies[oldRootName]
      }
      await fs.writeText(testPkgPath, JSON.stringify(testPkg, null, 2) + '\n')
    }

    // Rename in bun.lock too. The template ships a lockfile with the
    // old `sandstone-template` names baked into `workspaces` and
    // `packages` entries. Bun reads the lockfile to short-circuit
    // resolution; without rewriting it, the workspace `link:<name>`
    // entry would still point at the old name and the install would
    // fail to resolve the link for scoped packages (bun's auto-link-
    // during-install only works for unscoped names). A straight string
    // replace on the lockfile is sufficient because both occurrences
    // refer to the same template-supplied name.
    const lockPath = path.join(projectPath, 'bun.lock')
    if (await fs.pathExists(lockPath)) {
      const lockContent = await fs.readText(lockPath)
      await fs.writeText(lockPath, lockContent.split(oldRootName).join(libraryPackageName))
    }

    // Rewrite the import in test/src/test-display.ts to match the new name.
    const testDisplayPath = path.join(projectPath, 'test', 'src', 'test-display.ts')
    const testDisplay = await fs.readText(testDisplayPath)
    await fs.writeText(testDisplayPath, testDisplay.replace(`from '${oldRootName}'`, `from '${libraryPackageName}'`))

    // Rewrite the snapshot path prefix from /default/ to the chosen namespace.
    const snapPath = path.join(projectPath, 'test', '__snapshots__', 'index.test.ts.snap')
    const snap = await fs.readText(snapPath)
    await fs.writeText(snapPath, snap.replace('/default/', `/${namespace}/`))
  }

  await sh(`${packageManager} run setup`, { cwd: projectPath, stdio: 'inherit', throws: true })

  const configPath = path.join(projectPath, `${projectType === 'library' ? 'test/' : ''}sandstone.config.ts`)

  // Merge with the config values
  let templateConfig = await fs.readText(configPath)

  templateConfig = templateConfig.replace('packUid: \'kZZpDK67\'', `packUid: ${toJson(nanoid(8))}`)

  templateConfig = templateConfig.replace('name: \'template\'', `name: ${toJson(packName)}`)

  templateConfig = templateConfig.replace('namespace: \'default\'', `namespace: ${toJson(namespace)}`)

  // TODO: packFormat

  const optsJson = toJson(Object.fromEntries(Object.entries(saveOptions).filter(([_, value]) => value !== undefined)))

  if (optsJson !== '{}') {
    templateConfig = templateConfig.replace('saveOptions: {}', `saveOptions: ${optsJson}`)
  }

  // Rewrite config
  await fs.writeText(configPath, templateConfig)

  // Strip the dev-only `/patches` symlink + gitignore entry that the
  // workspace `bun dev:link` script adds. The symlink only exists for
  // local dev linking; new projects don't need it.
  const patchesPath = path.join(projectPath, 'patches')
  try {
    const stat = await fs.fileLstat(patchesPath)
    if (stat.isSymbolicLink()) {
      await fs.unlinkPath(patchesPath)
    }
  } catch {
    // not present — nothing to do
  }
  const gitignorePath = path.join(projectPath, '.gitignore')
  if (await fs.pathExists(gitignorePath)) {
    const before = await fs.readText(gitignorePath)
    // Drop the comment + bare `/patches` block added by bun dev:link.
    const after = before.replace(
      /\n*# Symlink to \.\.\/sandstone\/patches\/ for bun link workaround\n\/patches\n?/,
      '\n',
    )
    if (after !== before) {
      await fs.writeText(gitignorePath, after)
    }
  }

  const prefix = packageManager === 'npm' ? 'npm run' : packageManager
  console.log(chalk`{green Success!} Created "${projectName}" at "${projectPath}"`)

  console.log('Inside that directory, you can run several commands:\n')
  console.log(chalk`  {cyan ${prefix} dev:build}:\n    Builds the packs. {cyan ⛏}\n`)
  console.log(chalk`  {cyan ${prefix} dev:watch}:\n    Builds the packs, and rebuilds on each file change. {cyan ⛏}\n`)

  console.log('We suggest that you begin by typing:\n')
  console.log(chalk`  {cyan cd} ${projectName}\n  {cyan ${prefix} dev:watch}`)
}
