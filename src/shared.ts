import { Option } from 'commander'

interface OptionDef {
  flags: string
  description: string
  default?: unknown
  env?: string | false  // false to disable auto-env
}

function opt(flags: string, description: string, config?: { default?: unknown; env?: string | false }): OptionDef {
  return { flags, description, ...config }
}

/** Parse --long-name from flags like "-s, --long-name <value>" */
function parseLongFlag(flags: string): string | undefined {
  const match = flags.match(/--([a-z-]+)/)
  return match?.[1]
}

/** Convert kebab-case to SCREAMING_SNAKE_CASE with SANDSTONE_ prefix */
function toEnvVar(flagName: string): string {
  return 'SANDSTONE_' + flagName.toUpperCase().replace(/-/g, '_')
}

// Option definitions - use BuildOptions.get() to create Commander Option instances
const options = {
  // Flags
  dry: opt('-d, --dry', 'Do not save the pack. Mostly useful with `verbose`.'),
  verbose: opt('-f, --verbose', 'Fully log all resulting resources: functions, advancements...'),
  root: opt('-r, --root', 'Save the pack & resource pack in the .minecraft/datapacks & .minecraft/resource_packs folders. Override the value specified in the configuration file.'),
  fullTrace: opt('-t, --full-trace', 'Show the full stack trace on errors.'),
  strictErrors: opt('-e, --strict-errors', 'Stop pack compilation on type errors.'),
  production: opt('-p, --production', 'Runs Sandstone in production mode. This sets process.env.SANDSTONE_ENV to "production".'),

  // Values
  path: opt('-h,--path <path>', 'Path of the folder containing your sandstone workspace.', { default: './' }),
  name: opt('-n, --name <name>', 'Name of the datapack. Override the value specified in the configuration file.'),
  namespace: opt('-ns, --namespace <namespace>', 'The default namespace. Override the value specified in the configuration file.'),
  world: opt('-w, --world <name>', 'The name of the world to save the packs in. Override the value specified in the configuration file.'),
  clientPath: opt('-c, --client-path <path>', 'Path of the client folder. Override the value specified in the configuration file.'),
  serverPath: opt('--server-path <path>', 'Path of the server folder. Override the value specified in the configuration file.'),

  // TODO: ssh

  // Watch-specific
  manual: opt('-m, --manual', 'Manual reload mode - press r or Enter to rebuild after changes.', { env: 'WATCH_MANUAL' }),
  library: opt('-l, --library', 'Library mode - watches a library workspace based on the library project template.', { env: 'WATCH_LIBRARY' }),
  ignore: opt('-i, --ignore <globs...>', 'Additional glob patterns to ignore when watching for changes.', { env: 'WATCH_IGNORE_PATTERNS' }),
} satisfies Record<string, OptionDef>

export type OptionName = keyof typeof options

export const BuildOptions = {
  /** Get a Commander Option instance for the given option name */
  get(name: OptionName): Option {
    const def = options[name]
    const option = new Option(def.flags, def.description)
    if (def.default !== undefined) option.default(def.default)
    // Auto-generate env var from flag unless explicitly disabled (env: false)
    if (def.env !== false) {
      option.env(def.env === undefined ? toEnvVar(parseLongFlag(def.flags) ?? name) : `SANDSTONE_${def.env}`)
    }
    return option
  },
}