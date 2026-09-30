# sandstone-cli architecture

The CLI is a TypeScript/Bun project at the root of this repo. Five files cover how it works end-to-end:

| File | Topic |
|------|-------|
| [`connect-daemon.md`](./connect-daemon.md) | `sand connect` — the long-lived daemon, its WebSocket protocol, the RPC schema, and the streaming read/write pipeline |
| [`sand-run.md`](./sand-run.md) | `sand run <command>` — execute a Minecraft console command; either through the daemon or a direct host connection |
| [`hosts.md`](./hosts.md) | Host providers (`integrated`, `ssh`, `ftp`, `mcsmanager-login`) — the lifecycle and file/log/RCON surfaces |
| [`mcp-server.md`](./mcp-server.md) | `sand mcp` — the MCP server that exposes the daemon's resources and tools to an LLM agent |

## Module map

```
src/
  commands/
    connect/          # sand connect (daemon lifecycle + WS server)
      index.ts        # CLI entry point
      daemon.ts       # bootstrap, teardown, signal handlers
      server.ts       # Bun.serve WS handler + dispatch
      dispatch.ts     # RPC method → host call
      bootstrap.ts    # host instantiation + auto-config injection
      client.ts       # Client API for sand connect / sand run / MCP
      streams.ts      # per-WS stream registry + onClose bridge
      codec.ts        # msgpack encode/decode + stream-chunk framing
      codec-classify.ts # classifyWsMessage — single source for envelope dispatch
      stream-bridge.ts # makeStreamEndBridge — emits streamEnd/streamError envelopes
      host-capability.ts # callHostCapability + rpcError + UnsupportedCapabilityRpc
      signals.ts      # installShutdownSignals (SIGINT/SIGTERM/SIGBREAK)
      host-config.ts  # parseHostConfig (--host-config / --host-config-file parser)
      endpoint-file.ts # read/write endpoint file (.sandstone/connect.url)
      active-config.ts # load sandstone.config.ts + publishConfig flow
      subscriptions.ts # attachLog subscription tracking
      rpc.ts          # wire types (methods, params, results, events)
    run.ts           # sand run CLI entry point
    build/           # sand build + watch (legacy direct-mode pipeline)
  hosts/
    types.ts         # HostProvider, Capability, HostConfigInput
    index.ts         # provider registry
    _shared/
      attach-rcon.ts # shared RCON attach helper
    providers/
      integrated.ts  # CLI-managed local Fabric server
      ssh.ts         # node-ssh + sftp
      ftp.ts         # basic-ftp
      mcsmanager-login.ts # panel Login API + WS daemon
  mcp/
    server.ts        # MCP stdio server, resource/tool registration
    daemon-client.ts # DaemonClient wrapper (requireDaemon, mcpErrorData)
    with-daemon.ts   # withDaemon(ctx, fn) helper — error wrapping
    resources/       # readXxxLog, readClientLog, readSandstoneOutput, ...
    tools/           # runWorkspaceBuild, runServerCommand, ...
  utils/             # shared helpers (guards, logParams, fs, shell, ...)
```

## Cross-cutting concepts

- **Wire protocol**: every connection — daemon ↔ client, client ↔ MCP — is msgpack-encoded over WebSocket. Envelope shapes: `{id, method, params?, result?, error?}` (request/response), `{event, data}` (legacy event), `{method, params}` (notification). Classification in `codec-classify.ts`.
- **Streaming**: file read/write is end-to-end chunked. The dispatch's reader loop pulls one host chunk at a time, sends each as a 16-byte-prefixed binary frame, and sends `streamEnd` / `streamError` envelopes on completion / failure. No host ever buffers a full file in memory.
- **MCSManager** is the only host whose `writeFileStream` accepts an optional `size` hint — it uses the size to call `upload-new` upfront and stream `upload-piece` chunks instead of buffering. SSH / FTP / integrated ignore the size.

## Recent changes

The codebase went through a streaming + refactor pass that landed all of these without backwards-compat:

- Local-client host provider removed; client log access is now an intrinsic daemon RPC (`readClientLog`) reading the local Minecraft client's `logs/latest.log` directly via `fs.createReadStream`.
- Wire protocol bumped to msgpack envelopes; binary chunks for streams; `streamEnd` / `streamError` envelopes for completion / failure.
- Five new shared modules (`utils/guards`, `utils/logParams`, `hosts/_shared/attach-rcon`, `commands/connect/{signals,host-capability,stream-bridge,codec-classify,host-config}`, `mcp/with-daemon`) extracted from duplicated code in the daemon, hosts, MCP, and `sand run`.
