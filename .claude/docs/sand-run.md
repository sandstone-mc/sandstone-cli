# `sand run <command>`

`src/commands/run.ts`. Send a Minecraft console command. Two paths:

1. **Daemon-mode fast path**: if `sand connect` is running for this project, connect to the daemon's WS and send the command via the `executeRawCommand` RPC. Closes after the daemon replies.
2. **Direct-mode fallback**: bootstrap a host connection directly (same path `sand connect` uses internally), send the command, then disconnect.

## CLI flags

| Flag | Purpose |
|------|---------|
| `<command>` (positional) | The Minecraft command to send. Must be non-empty. |
| `--host-type <type>` | Provider to bootstrap for direct mode. Default: `integrated`. |
| `--host-config <json>` / `--host-config-file <path>` | Provider config (parsed via shared `parseHostConfig`). |
| `--bind <addr>` | WS bind address (irrelevant in direct mode; passed through to bootstrap). |
| `--port <n>` | WS bind port (same). |
| `--path <dir>` | Project root. |
| `--expect <pattern>` | Wait for this regex against subsequent log lines. |
| `--timeout <seconds>` | Wait up to this many seconds for `--expect` (default 30). |

## Daemon-mode fast path

When the daemon is running, `sand run` connects via the `Client` API (`src/commands/connect/client.ts`). The flow:

1. `endpointStatus(projectRoot)` → `'live'` (endpoint file exists with a live pid).
2. `requireDaemon(projectRoot)` → reads the endpoint file and returns a `Client`.
3. `client.executeRawCommand({command})` → returns `{output: string}`.
4. The captured RCON stdout is printed to the agent's terminal.

The client surface (`executeRawCommand`) is identical to the buffer-based `readFile` / `writeFile` — both have streaming variants (`readFileStream` / `writeFileStream`) but `sand run` doesn't use them (no file I/O happens here).

## Direct-mode fallback

When the daemon is NOT running:

1. `bootstrapHosts(hostType, perHostConfig, { userProvidedHostSettings })` — same call as `sand connect`'s daemon startup. Loads `sandstone.config.ts` if present, picks up defaults.
2. `runHost((h) => h.executeRawCommand(command))` — invokes the host's `executeRawCommand` (typically via RCON).
3. Disconnects the host, prints the captured output.

Direct mode still uses the same `executeRawCommand` semantics — if `command === 'stop'`, the host's `executeRawCommand` toggles `expectedShutdown` via the dispatch's `setExpectedShutdown(true)` so the inevitable JVM exit doesn't trip the host-lost watcher.

## Exit semantics

- Command sent + reply received → exit 0.
- Command sent + no reply within `--timeout` → exit 1.
- Bootstrap fails → exit 1 with the bootstrap error.
- Daemon unreachable + daemon mode requested → falls back to direct mode if `--host-type` is set; otherwise exit 1 with the connection error.
