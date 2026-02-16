import { writeFileSync } from 'fs'
import pkg from '../package.json'

writeFileSync('src/version.ts', `export const CLI_VERSION = '${pkg.version}'\n`)
