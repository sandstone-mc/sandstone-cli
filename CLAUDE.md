# Sandstone CLI

Command-line interface for Sandstone projects. Provides `sand` (project commands) and `create-sandstone` (project scaffolding).

## Commands

| Command | Description |
|---------|-------------|
| `sand create <name>` | Create a new Sandstone project |
| `sand build` | Build the datapack/resourcepack |
| `sand watch` | Build and rebuild on file changes |
| `sand install` | Install Smithed libraries |
| `sand uninstall` | Remove Smithed libraries |
| `sand refresh` | Clear library cache |

## Project Structure

```
sandstone-cli/
├── src/
│   ├── commands/          # CLI command implementations
│   │   ├── create.ts      # create-sandstone command
│   │   ├── build.ts       # sand build
│   │   ├── watch.ts       # sand watch (uses hot-hook for HMR in Node, modifies require.cache in Bun)
│   │   └── dependency.ts  # install/uninstall/refresh
│   ├── launchers/         # Minecraft installation detection
│   │   ├── types.ts       # LauncherProvider interface
│   │   ├── registry.ts    # Provider registry
│   │   ├── index.ts       # Auto-registers all providers
│   │   └── providers/     # Vanilla, Prism, Modrinth
│   ├── ui/                # Terminal UI components (Ink/React)
│   ├── utils.ts           # Shared utilities
│   └── index.ts           # Main CLI entry (Commander.js)
├── lib/                   # Built output (gitignored)
├── scripts/
│   └── test-harness.ts    # Interactive CLI testing tool
└── .test-runs/            # Test output directory (gitignored)
```

## Build Commands

```bash
bun dev:build    # Compile TypeScript and bundle
bun bundle       # Bundle only (after tsc, don't use this one directly)
```

## Test Harness

The test harness allows programmatic testing of interactive CLI prompts using node-pty.

```bash
# Create a project with pre-programmed responses
bun test:harness create my-pack --responses '[
  ["n", "enter"],           # Not a library
  ["enter"],                # Default version
  ["My Pack", "enter"],     # Pack name
  ["mypack", "enter"],      # Namespace
  ["up", "enter"],  # Save location: None
  ["enter"]                 # Package manager: bun
]'

# View test runs
bun test:harness list

# Clean up
bun test:harness cleanup
```

Test runs are saved to `.test-runs/<name>/` with a `test-run.log` containing cleaned output.

**Response format:**
- `["text", "enter"]` - Type text and press enter
- `["enter"]` - Accept default
- `["down", "enter"]` - Navigate and select
- Special keys: `enter`, `up`, `down`, `space`, `tab`, `escape`, `backspace`

## Launcher Detection

The CLI detects Minecraft installations across multiple launchers.

Paths are platform-aware (Windows, macOS, Linux including Flatpak).

### Adding a New Launcher

1. Create `src/launchers/providers/<name>.ts` implementing `LauncherProvider`
2. Export and register in `src/launchers/index.ts`

## Dependencies

- `commander` - CLI argument parsing
- `@inquirer/prompts` - Interactive prompts
- `ink` + `react` - Terminal UI components
- `@sandstone-mc/hot-hook` - HMR for watch mode
- `@parcel/watcher` - File system watching

## Create Command Flow

1. Ask if library or pack
2. Select Sandstone version
3. Enter pack name and namespace
4. Select save location (triggers launcher detection)
5. Select Minecraft instance (if root/world chosen)
6. Select world (if world chosen)
7. Select package manager
8. Clone template, install deps, configure

The `--root`, `--world`, `--client-path`, `--server-path` flags skip relevant prompts.
