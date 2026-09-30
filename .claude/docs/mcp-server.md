# `sand mcp` — the MCP server

`src/mcp/`. Exposes the daemon's resources and tools to an LLM agent via the [Model Context Protocol](https://modelcontextprotocol.io/). Runs as a stdio MCP server; the underlying `Client` (WebSocket to `sand connect`) is set up once at boot and reused.

## Entry point

`src/mcp/server.ts` registers all resources and tools with the MCP SDK's `McpServer`. Resource registration uses URI templates (`{?var}` style) — agents descend with their query params and the handler matches.

`setFallbackNotificationHandler(daemonClient, mcpServer)` (in `daemon-client.ts`) bridges the daemon's server-pushed WS notifications to MCP stdio notifications — daemon `notifications/resources/updated` for `sandstone://rebuild-state` etc. reach the MCP client as proper JSON-RPC notifications.

`forwardConfigChangedToResource(server, client, uri)` — daemon `configChanged` events trigger `server.sendResourceUpdated({ uri })` for the `sandstone://save-config` URI. Other resources derive from that one subscription.

## Shared MCP helpers

`src/mcp/with-daemon.ts` exports `withDaemon(ctx, fn)` — resolves the project's `sand connect` daemon, passes the typed `Client` to `fn`, catches errors, and wraps them via `mcpErrorData`. Resource / tool handlers use this to skip the `requireDaemon + try/catch mcpErrorData` boilerplate.

`src/mcp/daemon-client.ts` provides:
- `DaemonUnavailableError` — thrown when `sand connect` isn't running. The MCP SDK maps it to a JSON-RPC error with structured `data` so the agent sees actionable remediation.
- `requireDaemon(projectRoot)` — bootstrap a `Client` from the endpoint file. Throws `DaemonUnavailableError` if the daemon isn't live.
- `mcpErrorData(err)` — format any thrown error as `{error, message, ...}` MCP-shape data.

## MCP context

`McpContext = { projectRoot: string }`. `makeContext({ path })` resolves the project root once at boot; every handler receives the same context. `sand mcp` is invoked with `--path <dir>` (the same flag as every other `sand` command).

## Resources

Resources are URI templates — agents descend with their query vars. `sandstone://*` prefix.

### `sandstone://save-config`

`src/mcp/resources/getSaveConfig.ts`. Returns the active `sandstone.config.ts` snapshot (mode, configPath, saveConfig, outputDir, projectRoot, loadedAt, clientLogAvailable). Single-shape: no template vars.

### `sandstone://build-log{?tail,maxLines,from,to,since,until}`

`src/mcp/resources/readSandstoneLog.ts`. Reads the daemon's `readBuildLog` RPC. Translates the URI's `-1` sentinel for each filter to `null` via `coerceFileLogParams` (`src/utils/logParams.ts`). Response header:
```
# Watcher log (X of Y matched; Z buffered)
oldest: ...
newest: ...
TRUNCATED — increase tail/maxLines or narrow range/since
```
followed by the joined lines.

### `sandstone://test-log{?tail,maxLines,from,to,since,until}`

`src/mcp/resources/readTestLog.ts`. Same shape as build-log; reads `readTestLog`. Adds a "no test runner has pushed lines yet" note when the buffer is empty.

### `sandstone://server-log{?tail,maxLines,from,to,since,until}`

`src/mcp/resources/readServerLog.ts`. Same shape; reads `readServerLog`.

### `sandstone://client-log{?tail,from,to}`

`src/mcp/resources/readClientLog.ts`. Reads the daemon's intrinsic `readClientLog` RPC (the daemon streams the local Minecraft client's `logs/latest.log` via `fs.createReadStream` + `TextDecoder({stream: true})`, applies `tail` / `range` server-side, returns filtered lines). Returns an actionable message when `mode === 'library'` or `saveConfig.clientPath` is unset.

### `sandstone://build-output/{path}`

`src/mcp/resources/readSandstoneOutput.ts`. One level of the watcher's output dir (`path` matches exactly one segment).

### `sandstone://rebuild-state`

`src/mcp/resources/rebuildState.ts`. Single-shape: returns the latest `RebuildState` the watcher pushed.

### `sandstone://watcher-status`

`src/mcp/resources/watcherStatus.ts`. Single-shape: returns the latest `WatcherStatus` (or a sentinel when none).

## Tools

### `run_workspace_build`

`src/mcp/tools/runWorkspaceBuild.ts`. Triggers a rebuild by calling `daemon.publishTriggerBuild()`. The watcher's `triggerBuild` listener (registered via `Client.onTriggerBuild`) runs the rebuild path and consumes any pending changes (manual mode).

### `run_server_command`

`src/mcp/tools/runServerCommand.ts`. Forwards `sand run <command>` — connects to the daemon, calls `executeRawCommand`, returns the captured RCON stdout. Bootstrap behaviour was a hard lock-in from the user — this tool always tries to do the work, never errors with "daemon unavailable". Distinct from `getSaveConfig` / `readClientLog` / etc., which are read-only observers and DO fail cleanly when the daemon is down.

### `restart_server`

`src/mcp/tools/restartServer.ts`. Calls `daemon.stopServer()` then re-bootstraps a fresh connection to the new server. Errors when the host doesn't advertise `StopServer`.

### `run_test`

`src/mcp/tools/runTest.ts`. Stub / minimal — runs the configured test command. Details TBD.

### `run_sim_player_plan` / `get_sim_player_state`

`src/mcp/tools/runSimPlayerPlan.ts`, `getSimPlayerState.ts`. Sim-player testing stubs (TBD).

## URI-template → RPC mapping

The MCP resource layer is a thin translation between URI-template vars and the daemon's RPC params:

```
MCP URI template                      →  daemon RPC
{?tail,maxLines,from,to,since,until}    readBuildLog / readTestLog / readServerLog
{?tail,from,to}                       →  readClientLog
{?path}                                →  getBuildOutputTree (one path segment)
```

The shared `coerceFileLogParams` (and the 3-arg `coerceClientLogParams`) live in `src/utils/logParams.ts` so the sentinel convention (`-1` = "no filter") lives in exactly one place.

## Log header formatting

`formatLogHeader(label, result, extra?)` in `logParams.ts` builds the standard `# ... log (X of Y matched; Z buffered) / oldest: ... / newest: ... / TRUNCATED ...` block. `extra` is an array of additional optional lines (e.g. the "no test runner has pushed lines yet" note for `readTestLog`).

## Live updates

The daemon pushes `configChanged` events over WS. The MCP server subscribes via `client.onConfigChanged(...)` and:
- Forwards to the `sandstone://save-config` resource (the single subscription refreshes every save-config-derived resource).
- The dispatch notifies `sandstone://rebuild-state` and `sandstone://watcher-status` resources whenever the watcher pushes `RebuildState` / `WatcherStatus`. The MCP server subscribes to those notifications and emits `notifications/resources/updated` over stdio.

Clients subscribe via `resources/subscribe` and get the update notifications as the daemon pushes them.

## When to use the daemon directly vs. the MCP server

| Use case | Path |
|---------|------|
| Agent asks "what's the active config?" | `resources/read sandstone://save-config` |
| Agent asks "what's in the build log?" | `resources/read sandstone://build-log` |
| Agent wants to run a Minecraft command | `tools/call run_server_command` |
| Agent wants to trigger a rebuild | `tools/call run_workspace_build` |
| Agent wants to read a file from the host | NOT YET EXPOSED — would need a `resources/read` for `sandstone://host-file/...` (the daemon's `readFileStream` RPC supports it; just needs an MCP wrapper) |
| Agent wants to write a file to the host | NOT YET EXPOSED — same shape via `writeFileStream` |
