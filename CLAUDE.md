# Sandstone CLI

Command-line interface for Sandstone projects. Provides `sand` (project commands) and `create-sandstone` (project scaffolding).

## Commands

| Command | Description |
|---------|-------------|
| `sand create <name>` | Create a new Sandstone project |
| `sand build` | Build the datapack/resourcepack |
| `sand watch` | Build and rebuild on file changes |
| `sand refresh` | Clear library cache |
| `sand test` | Run GameTests on the configured server |
| `sand bench <config.json>` | Compare the in-game cost of two mcfunctions |

## `sand bench`

Profiles the server while two mcfunctions run and reports which is more
expensive. Implemented in `src/commands/bench/`.

| File | Role |
|------|------|
| `types.ts` | Config + result types |
| `config.ts` | Parses and validates the JSON config |
| `datapack.ts` | Generates the temporary datapack deployed into the server |
| `profile.ts` | Parses `server/profiling.txt` out of the profiling archive |
| `runner.ts` | Connects to the host, deploys, profiles, cleans up |
| `format.ts` | Human-readable and `--json` output |

The config file names the two functions to compare, plus optional one-shot
`setup` / `cleanup` mcfunctions:

```json
{
  "a": "mypack:fn_a",
  "b": "mypack:fn_b",
  "iterationsPerTick": 100,
  "setup": "mypack:reset_state"
}
```

`setup` and `cleanup` are run through the server console as
`function <id>` — once each, not every tick. `setup` runs before the
measured window, `cleanup` after it.

| Option | Meaning |
|--------|---------|
| `--iterations <n>` | Overrides the config's `iterationsPerTick`. |
| `--settle <seconds>` | How long to wait after `setup` before measuring. Default 10. The setup may do things that land asynchronously (forceloading a region, removing entities), and the functions need a moment to be compiled. |
| `--runs <n>` | How many profiling runs to average over. Default 1. The setup function runs once before the first run and the cleanup once after the last — the functions under test keep running throughout, so whatever they accumulate carries from one profile into the next. |
| `--json` | Also print the report to stdout. |

**The report is always saved** to `<project>/.sandstone/bench-result.json` —
next to the connect endpoint file — whether or not `--json` is passed.
`--json` only controls whether it is *also* printed.

**Averaging** (`src/commands/bench/average.ts`) happens over the runs, not
over the raw profiler percentages: each target gets the mean of its
`msPerTick` across the runs, the sample standard deviation, the min and
max, and the individual samples. The breakdown is grouped by section name
first, so a command that appears in every run stays one entry.

**How the measurement works.** The CLI writes a temporary datapack into the
server's `world/datapacks/sandstone_bench/` folder. Each target gets a
wrapper mcfunction that calls the target N times per tick, and *both wrappers
are registered directly in `#minecraft:tick`*.

That placement is the whole trick: Minecraft only gives a function its own
`function <id>` section in the profiling report when the function is executed
straight from a function tag. A function called from inside another function
is not sectioned — its commands fold into the caller's section — so two
targets sharing one wrapper could not be told apart afterwards.

The CLI then runs `perf start`, waits for the archive to be announced in the
server log (`Compressed to debug/profiling/<name>.zip`), reads it back with
`adm-zip`, and parses `server/profiling.txt`. Percentages in that report are
relative to the whole window, so `global% × timeSpanMs / tickSpan` gives
milliseconds per tick.

**Cleanup.** The temporary datapack is removed once the run is over. Hosts
that implement the `deleteEntry` capability (integrated, ssh, ftp) get the
whole `world/datapacks/sandstone_bench/` folder deleted; the rest fall back
to emptying the tick tag and blanking the wrappers, so the pack is left on
disk but inert. Either way the server is reloaded afterwards — a pack
deleted from disk stays live until the next reload.

The `deleteEntry` capability (`src/hosts/types.ts`) removes a file *or* a
directory and everything inside it, relative to the server directory. SFTP
and FTP have no recursive delete, so those providers walk the tree
themselves.

**What the profiler can and cannot attribute.** A function's own section
captures the commands it runs — including the whole cost of `summon`
(entity construction + registration) and `kill` (selector scan + the
synchronous unlink that `Entity.setRemoved` performs). What it does *not*
capture is the ongoing lifetime of what the function created: the entity's
per-tick cost lands on the level's `entities` section, entity section
load/unload bookkeeping lands on `entityManagement`, and the entity data is
written to the chunk by the IO worker at save time. A datapack that spawns
entities and leaves them alive therefore hides its real cost in the level's
tick, where no function owns it.

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
