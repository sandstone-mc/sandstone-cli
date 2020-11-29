import inquirer, { InputQuestion, Answers } from 'inquirer'
import fs from 'fs'
import os from 'os'
import path from 'path'

export async function getFlagOrPrompt<T extends Answers = Answers >(flags: Record<string, string | undefined | void | boolean>, name: string, inquirerProps: Omit<InputQuestion<T>, 'name'>): Promise<string> {
  const flagValue = flags[name]
  if (typeof flagValue === 'string') {
    return flagValue
  }

  return (await inquirer.prompt({ name, ...inquirerProps }) as Record<string, string>)[name]
}

/**
 * Get the .minecraft path
 */
export function getMinecraftPath(): string {
  function getMCPath(): string {
    switch (os.platform()) {
    case 'win32':
      return path.join(os.homedir(), 'AppData/Roaming/.minecraft')
    case 'darwin':
      return path.join(os.homedir(), 'Library/Application Support/minecraft')
    case 'linux':
    default:
      return path.join(os.homedir(), '.minecraft')
    }
  }

  const mcPath = getMCPath()

  if (!fs.existsSync(mcPath)) {
    throw new Error('Unable to locate the .minecraft folder. Please specify it manually.')
  }

  return mcPath
}

export function getWorldsList(): string[] {
  const mcPath = getMinecraftPath()
  const savesPath = path.join(mcPath, 'saves')

  return fs.readdirSync(
    savesPath,
    { withFileTypes: true }
  ).filter((f) => f.isDirectory).map((f) => f.name)
}

/**
 * @param worldName The name of the world
 * @param minecraftPath The optional location of the .minecraft folder.
 * If left unspecified, the .minecraft will be found automatically.
 */
export function getWorldPath(worldName: string, minecraftPath: string | undefined = undefined): string {
  let mcPath: string

  if (minecraftPath) {
    mcPath = minecraftPath
  } else {
    mcPath = getMinecraftPath()
  }

  const savesPath = path.join(mcPath, 'saves')
  const worldPath = path.join(savesPath, worldName)

  if (!fs.existsSync(worldPath)) {
    const existingWorlds = fs.readdirSync(savesPath, { withFileTypes: true }).filter((f) => f.isDirectory).map((f) => f.name)

    throw new Error(`Unable to locate the "${worldPath}" folder. Word ${worldName} does not exists. List of existing worlds: ${JSON.stringify(existingWorlds, null, 2)}`)
  }

  return worldPath
}
