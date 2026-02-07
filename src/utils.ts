import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import chalk from 'chalk-template'

/** Normalize a path to use forward slashes */
export const normalizePath = (p: string) => p.replaceAll('\\', '/')

export function hasYarn(): boolean {
  try {
    execSync('yarn --version')
    return true
  } catch (error) {
    return false
  }
}
export function hasPnpm(): boolean {
  try {
    execSync('pnpm --version')
    return true
  } catch (error) {
    return false
  }
}
export function hasBun(): boolean {
  try {
    execSync('bun --version')
    return true
  } catch (error) {
    return false
  }
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

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

export function getWorldsList(clientPath?: string): string[] {
  const mcPath = clientPath || getMinecraftPath()
  const savesPath = path.join(mcPath, 'saves')

  return fs.readdirSync(
    savesPath,
    { withFileTypes: true }
  ).filter((f) => f.isDirectory).map((f) => f.name)
}

// --- 1. Utilities to convert Union to Tuple (Standard TS Magic) ---
type UnionToIntersection<U> =
  (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never

type LastOf<T> =
  UnionToIntersection<T extends any ? () => T : never> extends () => (infer R) ? R : never

type Push<T extends any[], V> = [...T, V]

// Recursively moves items from Union T to a Tuple
type UnionToTuple<T, L = LastOf<T>, N = [T] extends [never] ? true : false> =
  true extends N ? [] : Push<UnionToTuple<Exclude<T, L>>, L>

// --- 2. The PowerSet Logic (Linear Recursion) ---
// We iterate over the tuple of keys. For every key, we double the result:
// (Current Results) | (Current Results + New Key)
type PowerSet<T, Keys extends any[] = UnionToTuple<keyof T>> =
  Keys extends [infer Head, ...infer Rest]
  ? PowerSet<T, Rest> | (
    Head extends keyof T
    ? { [K in Head]: NonNullable<T[K]> } & PowerSet<T, Rest>
    : never
  )
  : Record<string, never> // Base case: Empty object

// --- 3. Prettify Helper ---
// Merges intersections ({a:1} & {b:2}) into clean objects ({a:1, b:2})
// and distributes over the union to make tooltips readable.
type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

/**
 * Helper to add key-value pairs to an object if the values are not undefined.
 *
 * @returns An object with the key-value pairs if the values are not undefined, otherwise an empty object.
 */
export function add<O extends Record<string, any>>(obj: O): Prettify<PowerSet<O>> {
  const filtered = {}

  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (value !== undefined) {
      // @ts-ignore
      filtered[key] = value
    }
  }

  // @ts-ignore
  return filtered
}
