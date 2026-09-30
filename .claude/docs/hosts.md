# Host providers

`src/hosts/`. Every provider implements `HostProvider` (in `src/hosts/types.ts`):

```ts
interface HostProvider {
  readonly type: HostType
  readonly displayName: string
  readonly capabilities: HostCapabilities
  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  startServer?(): Promise<void>
  stopServer?(): Promise<void>
  readFile?(path): Promise<Buffer>
  readFileStream?(path, opts?): Promise<{ stream, size? }>
  writeFile?(path, data): Promise<void>
  writeFileStream?(path, opts?): Promise<WritableStream>
  attachLog?(onChunk): Promise<LogSubscription>
  executeRawCommand?(command): Promise<string>
  isRunning?(): boolean
  onDisconnected?(handler): () => void
}
```

Capabilites are a `Set<Capability>` where `Capability ∈ { StartServer, StopServer, ReadFile, WriteFile, AttachLog, ExecuteRawCommand, ExecuteRawCommandHasResponse }`. The daemon's dispatch uses `callHostCapability` (in `src/commands/connect/host-capability.ts`) to validate before invoking — the helper throws `UnsupportedCapabilityRpc` if the host doesn't advertise the cap, or `notImplemented` if the cap is advertised but the method is undefined.

The four registered providers (in `src/hosts/index.ts`):

| Type | Display name | File | Capabilities |
|------|--------------|------|-------------|
| `integrated` | Integrated Fabric Server | `providers/integrated.ts` | Start, Stop, Read, Write, AttachLog, ExecRaw, ExecRawHasResp |
| `ssh` | SSH | `providers/ssh.ts` | Start, Stop, Read, Write, AttachLog (+ ExecRaw + ExecRawHasResp if `rcon` config provided) |
| `ftp` | FTP | `providers/ftp.ts` | Read, Write, AttachLog (+ ExecRaw + ExecRawHasResp if `rcon` config provided) |
| `mcsmanager-login` | MCSManager (Login) | `providers/mcsmanager-login.ts` | Read, Write, AttachLog, ExecRaw, ExecRawHasResp |

`KNOWN_HOST_TYPES` (in `types.ts`) is the canonical list — `sand connect` validates the user's `--host-type` against it.

## Shared RCON helper

`src/hosts/_shared/attach-rcon.ts` exports `attachRconIfConfigured(host, cfg, rconHost, label, onLog, setters)` — used by SSH and FTP to open + authenticate an RCON connection (when `config.rcon` is configured) and mutate host state via setter callbacks (so the helper doesn't require public fields on the host). On failure the rcon is cleared, an error is logged via `onLog`, and the host keeps working without RCON. `integrated` has its own RCON path because it needs to wire socket close/error into its `disconnectHandlers` set.

## `integrated` — CLI-managed local Fabric server

`src/hosts/providers/integrated.ts`. The most complex host — owns the server process.

### Lifecycle

`connect()`:
1. `fs.ensureDir(serverDir)` + `ensureEulaAccepted()` (writes `eula=true` if missing — Mojang's EULA is accepted on the user's behalf by invoking the CLI).
2. `resolveServerPort()` — probe 127.0.0.1 from 25565 up; bind a probe Bun.serve, capture port, stop, return.
3. `writeServerProperties()` — owned keys only (preserves user's edits); applies `level-type` / `generator-settings` / `level-name` / RCON / `server-port` from config.
4. `resolveMinecraftVersion()` — either maps `sandstoneVersion` via PrismLauncher's meta-launcher `net.fabricmc.fabric-loader/package.json` `recommended` array, or uses `config.minecraftVersion` verbatim. Classifies as `release` vs `snapshot` based on `-snapshot` / `-pre` / `-rc` suffix.
5. `ensureJava(major, javaDir)` — fetches the right Java major if not on disk (cached in `javaDir`).
6. Re-install Fabric server if loader version is stale OR MC version mismatch with the manifest. Mods are re-resolved only when MC changes.
7. `ensureModsTracked(mcVersion)` — backfill the manifest's `installedMods` for existing servers (hash every jar, ask Modrinth).
8. `checkModUpdates(mcVersion)` — auto-update pass, throttled by `lastModUpdateCheck` (1 hour cooldown).
9. `needsInitialWorldSetup = !fileExists('world/level.dat')` — track first-run world setup.

`startServer()`:
- Idempotent: if "Done (" already seen, return. If a child is in flight, wait on `resolveReady`.
- Resolve jar path, require it to exist (`fabric-server-launch.jar`).
- Reset log + rcon state.
- `child_process.spawn(java.path, ['-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: serverDir, detached: true, ... })`.
- Wait on a `Promise.all([donePromise, rconReadyPromise])` — done when both "Done (" line AND `RCON running on ...` are seen.
- `connectRcon()` — open + authenticate `RconClient` against `127.0.0.1:<rcon.port>`, install liveness handlers that fan into `disconnectHandlers` (so the daemon's host-lost watcher sees RCON drops too).
- If `needsInitialWorldSetup` was set: `fill` + `setblock` to lay down the spawn platform, awaited via `detectLogLine`.

`stopServer()`:
- Reset `doneDetected` (the flag was for the OLD JVM).
- If `child` exists and not killed: race `rcon.execute('stop')` against `waitForExit(child)`. If neither resolves within `gracefulStopTimeoutSeconds`, escalate SIGTERM → SIGKILL.
- `destroyRcon()`.

`disconnect()`:
- Detach `disconnectHandlers` first (so our own SIGTERM exit doesn't trigger our own handler).
- `destroyRcon()`.
- SIGTERM the JVM, wait for it to actually exit (avoids the next test run failing to bind the same port).

`executeRawCommand(command)`:
- RCON-only. Throws `Server is not running (rcon not connected)` if rcon isn't ready.
- For "whitelisting local connection attempts": when a `lost connection: You are not white-listed on this server!` line matches a local (`127.0.0.1`) client, fire-and-forget `whitelist add <player>` + `op <player>` and log the event.

`attachLog(onChunk)`:
- Add `onChunk` to `logHandlers` (a `Set<LogChunkHandler>`).
- `unattach()` removes the handler, flushes any `partialLine` (so trailing lines without a `\n` are still delivered).

`readFileStream` / `writeFileStream`:
- Direct `fs.createReadStream` / `fs.createWriteStream` wrapped in `Readable.toWeb` / `Writable.toWeb`. `writeFileStream`'s `opts.size` is ignored (native streaming sink).

## `ssh` — SSH via node-ssh

`src/hosts/providers/ssh.ts`.

### Lifecycle

`connect()`:
- `node-ssh.connect({ host, port, username, password|privateKey })`.
- `attachRconIfConfigured(...)` — opens + authenticates rcon over the same host on the configured RCON port, adds `ExecuteRawCommand*` capabilities on success.

`startServer()` — `ssh.execCommand(startCommand, { cwd: serverDir })`. Throws if exit code is non-zero.

`stopServer()`:
- If `consoleSession` is set: try driving the session via `screen -X stuff "stop\n"` or `tmux send-keys -t <session> 'stop' Enter`. If the keystroke lands, wait up to `gracefulStopTimeoutSeconds` for the process to exit (poll `pgrep -f <startCommand>`).
- Fallback: `ssh.execCommand(stopCommand)`.

`readFileStream(path)`:
- **Fast-fail on `stat()` first** — if the file doesn't exist (`stat` throws), throw immediately. ssh2's `createReadStream` opens the stream asynchronously and emits an `'error'` event on failure, but ssh2's internal Promise rejection is unhandled and would crash the daemon. Failing fast avoids that.
- `sftp.createReadStream(path)` wrapped in `Readable.toWeb`.
- A no-op `'error'` listener is attached to the Node stream so the raw error event has an owner (`Readable.toWeb` is supposed to forward, but the raw Node event still needs a listener).

`writeFileStream(path)`:
- `sftp.createWriteStream(path)` wrapped in `Writable.toWeb`.
- Same defensive `'error'` listener on the Node stream.

`executeRawCommand(command)`:
- RCON-only (`this.rcon.execute(command)`). Throws if rcon isn't configured.

`attachLog(onChunk)`:
- `ssh.execCommand('tail -F -n 0 <logPath>', { cwd: serverDir, onStdout: (chunk) => ... })`. Returns immediately; the tail runs until `disconnect()`. The handler splits on `\n` and fires `onChunk` per line. `unattach()` marks `stopped` (no further chunks are delivered).

## `ftp` — FTP via basic-ftp

`src/hosts/providers/ftp.ts`.

### Lifecycle

`connect()`:
- `client.access({ host, port, user, password })`.
- `attachRconIfConfigured(...)`.

`executeRawCommand(command)` — RCON-only, same pattern as SSH.

`readFileStream(path)`:
- **Fast-fail on `size()`** — if FTP `SIZE` fails (file missing), throw immediately. Pressing on to `downloadTo` would trigger another 550 mid-stream AND basic-ftp's internal `_onControlSocketData` emits an `'error'` event we can't intercept cleanly.
- `client.downloadTo(node, path)` where `node = new PassThrough()`; `Readable.toWeb(node)` exposes the chunks.
- The download promise rejects on host error; we `.catch((err) => node.destroy(err))` to propagate the error to the web stream's controller.

`writeFileStream(path)`:
- `client.uploadFrom(node, path)` where `node = new PassThrough()`; `Writable.toWeb(node)` exposes the writer.
- Same `.catch` pattern.

### FTP control-channel serialization

basic-ftp's client doesn't allow concurrent operations on its single control channel. We expose this constraint through a FIFO `ftpQueue`:

```ts
private ftpQueue: Promise<unknown> = Promise.resolve()
private ftpSerialize<T>(op: () => Promise<T>): Promise<T> { ... }
```

Every public method that touches `this.client` is wrapped: `readFileStream`, `writeFileStream`, `attachLog`'s tick + prime, `disconnect`'s close. `writeFileStream` pushes `upload.then(...)` onto the queue so a follow-up read waits for the upload's data + control channel to fully settle.

## `mcsmanager-login` — panel Login API + WS daemon

`src/hosts/providers/mcsmanager-login.ts`. Talks to a panel running `MCSManager` (panel-managed Minecraft instances).

### Lifecycle

`connect()`:
- Seed `cookie` + `token` from `MCS_MANAGER_COOKIE` / `MCS_MANAGER_TOKEN` env vars if present; otherwise force a login via `/api/auth/login` (POST `{ username, password, code: '' }` with the panel's `Origin` + `Referer` headers, parse 2 `Set-Cookie` headers + a session token from the response body).
- After login, leave `executeRawCommand` on the legacy in-place RCON path. The `attachRconIfConfigured` helper isn't used here because the panel's RCON host string comes from the `config.endpoint` URL (constructed at registration time), not `config.host`. Wiring that would require either a constructor-time `endpoint` parameter or per-call lookup.

`attachLog(onChunk)`:
- Open the daemon WebSocket (`socket.io-client` → `ws://<panel-host>:24444/<prefix>/socket.io`).
- Send `stream/auth` with the channel password; wait for ack.
- Subscribe to `instance/stdout`, split on `\n`, fire `onChunk` per line. `unattach()` removes the listener and flushes the partial line.

`readFileStream` / `writeFileStream`:
- `readFileStream` returns the `resp.body` of `fetch(<downloadUrl>)` directly. The HTTP body is already a `ReadableStream<Uint8Array>` so chunks flow as the panel sends them.
- `writeFileStream(path, opts?)`:
  - With `opts.size !== undefined`: register `upload-new` upfront with the known size, then stream `upload-piece` chunks as they arrive (coalesced into `PIECE_SIZE = 2_097_374`-byte payloads via a pending buffer). On close, verifies `offset === expectedSize`.
  - Without `opts.size`: buffer all chunks into a list, concat on close, then run the existing `uploadChunks` (which slices the buffer into 2 MiB pieces). Falls back to this when the size isn't known up front.
- `writeFileStream` uses `uploadChunk` (the single-piece helper) as the inner unit.

## Host lifecycle observability

Every host implements `onDisconnected(handler)` (optional). The dispatch's bootstrap registers one handler per host that:

- Marks the host as disconnected in the dispatch context (`ctx.setActiveConfig(undefined)` — no, that's the config; the actual mechanism is `handleSessionClose` flipping `connected: false` on the cached `WatcherStatus`).
- Fires `disconnectHandlers` for downstream liveness-loss consumers.

The dispatch's `bootstrapHosts` calls `m.onDisconnected(...)` for each host's member. When a JVM dies or an SSH connection drops, the handler runs and (unless `expectedShutdown` was set) triggers `handle.shutdown()`.

## Where to look

- `src/hosts/types.ts` — capability enum, host type literal union, config input union.
- `src/hosts/index.ts` — provider registration, `createHost(hostType, config)` factory.
- `src/hosts/_shared/attach-rcon.ts` — shared RCON wiring.
- `src/commands/connect/bootstrap.ts` — host instantiation + auto-config injection.
