# `sand connect` — the daemon

`src/commands/connect/index.ts` is the CLI entry point. `sand connect` does one of two things:

- **Default**: bootstrap a long-lived daemon process that hosts one provider, listen on a local WebSocket port, write the endpoint to `<projectRoot>/.sandstone/connect.url`.
- **`--shutdown`**: read the endpoint file, send the `shutdown` RPC over WS, exit 0.

The endpoint file is the contract surface — other tools (`sand run`, `sand mcp`) read it to discover the daemon's URL + secret.

## CLI flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--host-type <type>` | `integrated` | Host provider. Validated against `KNOWN_HOST_TYPES` (in `src/hosts/types.ts`). |
| `--host-config <json>` | — | Inline JSON for the provider. Sensitive-key check warns on `privateKey` / `password` / `cookie` / `token` (visible in `ps aux`). |
| `--host-config-file <path>` | — | JSON config from file. Recommended over `--host-config` for any sensitive keys. |
| `--bind <addr>` | `127.0.0.1` | WS bind address. |
| `--port <n>` | `0` (OS-assigned) | WS bind port. |
| `--path <dir>` | (required) | Project root. |
| `--shutdown` | — | Read endpoint, send shutdown RPC. |

CLI parsing flows through `parseHostConfig` (`src/commands/connect/host-config.ts`) which validates JSON shape + emits the sensitive-key warning.

## Daemon bootstrap

`startDaemon` (`src/commands/connect/daemon.ts`) does, in order:

1. Validate the endpoint file isn't live (no other daemon running for this project).
2. Call `bootstrapHosts(hostType, perHostConfig, { userProvidedHostSettings, ... })` to instantiate the provider. Reads `sandstone.config.ts` if present and injects `sandstoneConfig` into the per-host config.
3. Open the WebSocket via `startServer` (port-resolved at bind time).
4. Write the endpoint file (URL + secret + pid + projectRoot).
5. Register signal handlers (`installShutdownSignals` covers SIGINT / SIGTERM / SIGBREAK) and process-level `uncaughtException` / `unhandledRejection` loggers.
6. Await `handle.done` (resolved by signal handler or `shutdown` RPC); `process.exit(0)`.

The `handle` exposes `{ url, endpoint, shutdown, done }` to the CLI parent.

## Wire protocol

Every WS frame is a single msgpack-encoded envelope. Envelope shapes:

```ts
// Request (client → server)
{ id: 1, method: 'writeFile', params: { path, size } }

// Response (server → client)
{ id: 1, result: { streamId: 'abc...' } }
// or
{ id: 1, error: { code: -32603, message: 'internal error' } }

// Legacy event (server → client, push)
{ event: 'log', data: { subscriptionId, lines } }

// JSON-RPC notification (client → server, push — used for streamEnd)
{ method: 'streamEnd', params: { streamId, bytes } }
```

Classification lives in `src/commands/connect/codec-classify.ts` — single `classifyWsMessage(raw)` returns `{ kind: 'request' | 'response' | 'event' | 'notification', ... }`. Both `client.ts` and `server.ts` use it; no inline envelope detection remains.

## RPC schema

Full surface in `src/commands/connect/rpc.ts` (`RpcMethod`, `RpcResult`, the various `XxxParams` / `XxxResult` types). Summary:

| Method | Direction | Purpose |
|--------|-----------|---------|
| `ping` | request | Health probe. |
| `startServer` / `stopServer` | request | Lifecycle. `stopServer` toggles `expectedShutdown` so the host-lost watcher doesn't tear down the daemon. |
| `readFile` / `writeFile` | request | Buffering variants — buffer the full file in memory. Still supported for tests + the existing MCP `readClientLog` path that consumed `daemon.readFile({path})`. Prefer `readFileStream` / `writeFileStream` for new code. |
| `readFileStream` / `writeFileStream` | request | Streaming variants. Server returns `{streamId}` synchronously; chunks flow as binary frames prefixed with the 16-byte streamId; completion is signaled by `streamEnd` (success) or `streamError` (failure) envelopes. `writeFileStream` accepts an optional `{size}` hint — see the hosts doc for the MCSManager special case. |
| `streamEnd` | notification (client → server) | Client → server: closes the server-side stream registry entry (which closes the host WritableStream via `onClose`). |
| `executeRawCommand` | request | RCON-only. Returns the captured stdout. The literal command `"stop"` (case-insensitive) flips `expectedShutdown` so the inevitable JVM exit doesn't trip the host-lost watcher. |
| `attachLog` / `unattach` | request | Subscribe to host log lines; server coalesces per-WS into ≤50ms batches. |
| `shutdown` | request | Throw `ShutdownSignal` — server replies OK, broadcasts `daemonShutdown`, kicks off teardown. |
| `getActiveConfig` | request | Live read of `activeConfig` (closure-backed, not a snapshot). Returns `clientLogAvailable: boolean` so tools can pre-check. |
| `getBuildOutputTree` | request | One level of the watcher's output dir. |
| `readBuildLog` / `readTestLog` / `readServerLog` | request | Filtered slices of the daemon's in-memory log buffers (1000-line circular cap per target). |
| `readClientLog` | request | **Intrinsic daemon capability** — reads the local Minecraft client's `logs/latest.log` (resolved via `saveConfig.clientPath`). The file is on the daemon's machine, regardless of which host provider owns the MC server. |
| `getWatchedFiles` | request | Watcher's tracked files. |
| `publishConfig` / `publishLog` / `publishRebuild` / `publishWatcherStatus` | notification (client → server) | Watcher → daemon updates the in-memory state. |
| `getRebuildState` / `getWatcherStatus` | request | Snapshot reads. |
| `publishTriggerBuild` | request | MCP `runWorkspaceBuild` tool → daemon → watcher rebuild path. |

## Streaming pipeline

File I/O is end-to-end chunked. No host ever buffers a full file in memory.

### Read path (`handleReadFile` in `dispatch.ts`)

1. RPC arrives. Dispatch validates the host has `readFileStream` via `callHostCapability`.
2. Calls `h.readFileStream(path)` — host returns `{ stream: ReadableStream<Uint8Array>, totalSize? }`.
3. Server registers a stream entry in the per-WS `StreamRegistry` and returns `{streamId, totalSize}` to the client.
4. An async reader loop pulls one chunk from `stream.getReader()` and sends it as `encodeStreamChunk(hexToBytes(streamId), chunk)` over WS.
5. On natural EOF or reader rejection: `streams.close(streamId, bytes, err?)` fires the registry's `onClose(bytes, err?)` bridge.
6. The bridge (`makeStreamEndBridge`) sends a `streamEnd` (success) or `streamError` (failure) envelope.
7. The client's `streamEnd` / `streamError` dispatcher closes the controller + resolves/rejects `done`.

### Write path (`handleWriteFile`)

1. RPC arrives. Dispatch calls `h.writeFileStream(path, opts?)`.
2. Server registers a stream entry, returns `{streamId}`.
3. Client's `openOutboundStream(streamId, ...)` (now driven by the server's streamId — the server is the source of truth) starts pumping chunks via `encodeStreamChunk` until the source ReadableStream closes.
4. Client sends `streamEnd` notification.
5. Server's `handleStreamEnd` reads `bytes?` from the client (currently `0`; server tracks its own count) + calls `streams.close(streamId, bytes)`.
6. The bridge sends `streamEnd` envelope → client `done` resolves.

The `ws?.send(encodeStreamChunk(...))` is the only hot path — no buffering.

## Disconnect + shutdown

- **WS close** → `sessions.delete(ws)` + clear flush timers + `subscriptions.dropAllForWs(ws)` + `streams.closeAll(new Error('ws session closed'))`. After a write is closed, the bridge emits nothing on the dead socket.
- **`shutdown` RPC** → `ShutdownSignal` thrown in dispatch → reply OK → broadcast `daemonShutdown` event → `handle.shutdown()`.
- **Signal** (SIGINT/SIGTERM/SIGBREAK) → same `handle.shutdown()` path.

Shutdown sequence (in `teardown`):
1. `broadcast('daemonShutdown', { reason })` to every connected session.
2. If the host owns the server (`integrated`), call `host.stopServer()` (RCON `stop` → SIGTERM → SIGKILL fallback).
3. Delete the endpoint file (with pid check).
4. Stop the WS server (`server.stop()`).
5. `host.disconnect()`.

## Error translation

`errorToRpc(err)` (in `rpc.ts`) maps host-level errors to wire codes:
- `UnsupportedCapabilityRpc` → `UnsupportedCapability` (`-32001`)
- `NotConnectedError` → `NotConnected` (`-32002`)
- `UnknownSubscription` → `UnknownSubscription` (`-32003`)
- `HostAuthError` → `AuthFailed` (`-32004`)
- Plain `Error` → `InternalError` (`-32603`)

Unknown methods throw (server-side) or surface as `MethodNotFound` (`-32601`).

## Configuration injection

`loadActiveConfigFromDisk(projectRoot)` reads `sandstone.config.ts` once at boot. The watcher's `publishConfig` (called on every hot reload) pushes the new config to the dispatch via `setActiveConfig`. The dispatch exposes the latest snapshot through `ctx.activeConfig` (a closure-backed reference, NOT a per-call snapshot — `getActiveConfig` always sees the current value).

When the daemon hasn't loaded a config (e.g. started outside a Sandstone project), `ctx.activeConfig` is `undefined` and `getActiveConfig` throws `NotConnected` (`-32002`).
