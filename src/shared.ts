export const BuildDeclares = {
    // Flags
    dry: ['-d, --dry', 'Do not save the pack. Mostly useful with `verbose`.'],
    verbose: ['-v, --verbose', 'Log all resulting resources: functions, advancements...'],
    root: ['-r, --root', 'Save the pack & resource pack in the .minecraft/datapacks & .minecraft/resource_packs folders. Override the value specified in the configuration file.'],
    fullTrace: ['-t, --full-trace', 'Show the full stack trace on errors.'],
    strictErrors: ['-s, --strict-errors', 'Stop pack compilation on type errors.'],
    production: ['-p, --production', 'Runs Sandstone in production mode. This sets process.env.SANDSTONE_ENV to "production".'],
  
    // Values
    path: ['--path <path>', 'Path of the folder containing source files.', './src'],
    config: ['--config-path', 'Path of the sandstone.config.ts folder.', './'],
    name: ['-n, --name <name>', 'Name of the datapack. Override the value specified in the configuration file.'],
    namespace: ['-ns, --namespace <namespace>', 'The default namespace. Override the value specified in the configuration file.'],
    world: ['-w, --world <name>', 'The name of the world to save the packs in. Override the value specified in the configuration file.'],
    clientPath: ['-c, --client-path <path>', 'Path of the client folder. Override the value specified in the configuration file.'],
    serverPath: ['--server-path <path>', 'Path of the server folder. Override the value specified in the configuration file.'],

    // TODO: ssh

    enableSymlinks: ['--enable-symlinks', 'Force enable/disable symlinks. Defaults to false. Useful if you want to enable symlinks on Windows.'],
    manual: ['-m, --manual', 'Manual reload mode - press r or Enter to rebuild after changes.'],
  } as unknown as Record<string, [string, string, RegExp, boolean]> // Haha TypeScript funny