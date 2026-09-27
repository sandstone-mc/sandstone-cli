/**
 * The `sand mcp` MCP server.
 *
 * A stdio MCP server that exposes the project's Sandstone state to LLM
 * agents (Claude Code, Cursor, etc.). All state is read from the
 * running `sand connect` daemon — this server never touches the
 * filesystem directly, never parses `sandstone.config.ts` itself, and
 * never spawns anything. The one exception is `runServerCommand`,
 * which is allowed to bootstrap a direct host connection when the
 * daemon isn't running (mirrors `sand run`'s behaviour).
 *
 * Capability surface (advertised in `initialize`):
 *   - `tools: { listChanged: false }`     — static set of 7 tools
 *   - `resources: { subscribe: true, listChanged: false }` — agents
 *     can subscribe to specific resources and receive
 *     `notifications/resources/updated` when the daemon pushes
 *     `configChanged`.
 *   - `logging: {}`                        — server-initiated log
 *     notifications mirror console output. Agents see them only if
 *     their client surfaces logging notifications; mostly for humans.
 *
 * Lifecycle:
 *   1. Read `.sandstone/connect.url`. If no daemon is running, the
 *      server still starts (most resources will return
 *      `DaemonUnavailableError` per call). Forcing the agent to be
 *      useful even without a daemon isn't worth the complexity — v1
 *      keeps it honest.
 *   2. Connect to the daemon (best-effort). On success, subscribe to
 *      `configChanged` and translate events to
 *      `notifications/resources/updated` for `sandstone://save-config`.
 *   3. Register every resource + tool. Stubs stay stubs.
 *   4. Hand control to the MCP SDK; the process stays alive until
 *      stdin closes or the client disconnects.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import * as getSaveConfig from './resources/getSaveConfig.js'
import * as readSandstoneLog from './resources/readSandstoneLog.js'
import * as readSandstoneOutput from './resources/readSandstoneOutput.js'
import * as readClientLog from './resources/readClientLog.js'
import * as readServerLog from './resources/readServerLog.js'
import * as readTestLog from './resources/readTestLog.js'
import * as rebuildState from './resources/rebuildState.js'
import * as watcherStatus from './resources/watcherStatus.js'

import * as runWorkspaceBuild from './tools/runWorkspaceBuild.js'
import * as deployToServer from './tools/deployToServer.js'
import * as restartServer from './tools/restartServer.js'
import * as runServerCommand from './tools/runServerCommand.js'
import * as runTest from './tools/runTest.js'
import * as runSimPlayerPlan from './tools/runSimPlayerPlan.js'
import * as getSimPlayerState from './tools/getSimPlayerState.js'

import {
  forwardConfigChangedToResource,
  forwardNotificationsToStdio,
  makeContext,
  requireDaemon,
  type McpContext,
} from './daemon-client.js'

/** Build, register, and return an `McpServer` ready to connect. */
export async function buildMcpServer(opts: { path: string; version: string }): Promise<McpServer> {
  const ctx = makeContext(opts)

  const server = new McpServer(
    {
      name: 'sandstone-mcp',
      version: opts.version,
    },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: false },
        tools: { listChanged: false },
        logging: {},
      },
      instructions:
        'Sandstone MCP server. Reads live state from the `sand connect` daemon. ' +
        'For server commands (`runServerCommand`) the tool bootstraps a direct connection if the daemon is down. ' +
        'All other resources/tools fail cleanly when the daemon is unavailable.',
    },
  )

  // -----------------------------------------------------------------
  // Resources
  // -----------------------------------------------------------------
  server.resource(
    getSaveConfig.NAME,
    getSaveConfig.URI,
    async (uri) => {
      const r = await getSaveConfig.read(ctx)
      return { contents: [r] }
    },
  )
  // Log readers use URI templates so callers can pass `tail` / `rangeFrom` /
// `rangeTo` / `since` / `until` query params. RFC 6570 expansion gives
// us `params` as a `{key: string}[]` we coerce to numbers for the
// handlers below.
  server.resource(
    readSandstoneLog.NAME,
    new ResourceTemplate(readSandstoneLog.URI, { list: undefined }),
    async (uri, params) => {
      const r = await readSandstoneLog.read(ctx, coerceLogParams(params))
      return { contents: [r] }
    },
  )
  // Fixed URI for the build-output root. The template `{path}` below
  // can't match zero-length segments, so the root is registered twice:
  // once as a fixed URI, once as the template for descendants.
  server.resource(
    `${readSandstoneOutput.NAME}-root`,
    readSandstoneOutput.FIXED_URI,
    async (uri) => {
      const r = await readSandstoneOutput.read(ctx, '')
      return { contents: [r] }
    },
  )
  // Template: `sandstone://build-output/{path}` — agents descend with
  // subpaths. `{path}` matches exactly one segment.
  server.resource(
    readSandstoneOutput.NAME,
    new ResourceTemplate(readSandstoneOutput.TEMPLATE_URI, { list: undefined }),
    async (uri, params) => {
      const path = typeof params.path === 'string' ? params.path : ''
      const r = await readSandstoneOutput.read(ctx, path)
      return { contents: [r] }
    },
  )
  server.resource(
    readClientLog.NAME,
    new ResourceTemplate(readClientLog.URI, { list: undefined }),
    async (uri, params) => {
      const r = await readClientLog.read(ctx, coerceFileLogParams(params))
      return { contents: [r] }
    },
  )
  server.resource(
    readServerLog.NAME,
    new ResourceTemplate(readServerLog.URI, { list: undefined }),
    async (uri, params) => {
      const r = await readServerLog.read(ctx, coerceFileLogParams(params))
      return { contents: [r] }
    },
  )
  server.resource(
    readTestLog.NAME,
    new ResourceTemplate(readTestLog.URI, { list: undefined }),
    async (uri, params) => {
      const r = await readTestLog.read(ctx, coerceLogParams(params))
      return { contents: [r] }
    },
  )
  // Fixed URI: synthetic `sandstone://rebuild-state` resource backed by
  // the daemon's latest `publishRebuild` snapshot. Watcher pushes
  // state at build start + finish; daemon fires
  // `notifications/resources/updated` to every subscribed client.
  server.resource(
    rebuildState.NAME,
    rebuildState.URI,
    async (uri) => {
      const r = await rebuildState.read(ctx)
      return { contents: [r] }
    },
  )
  // Fixed URI: synthetic `sandstone://watcher-status` resource. Watcher
  // publishes its runtime state on connect; daemon flips
  // `connected: false` when the watcher's WS session closes.
  server.resource(
    watcherStatus.NAME,
    watcherStatus.URI,
    async (uri) => {
      const r = await watcherStatus.read(ctx)
      return { contents: [r] }
    },
  )

  // -----------------------------------------------------------------
  // Tools
  // -----------------------------------------------------------------
  server.tool(
    runWorkspaceBuild.NAME,
    runWorkspaceBuild.DESCRIPTION,
    {},
    async (_args, _extra) => runWorkspaceBuild.call(ctx),
  )
  server.tool(
    deployToServer.NAME,
    deployToServer.DESCRIPTION,
    { dry: z.boolean().optional() },
    async (args) => deployToServer.call(ctx, args as { dry?: boolean }),
  )
  server.tool(
    restartServer.NAME,
    restartServer.DESCRIPTION,
    { timeoutSeconds: z.number().optional() },
    async (args) => restartServer.call(ctx, args as { timeoutSeconds?: number }),
  )
  server.tool(
    runServerCommand.NAME,
    runServerCommand.DESCRIPTION,
    {
      command: z.string(),
      hostType: z.string().optional(),
      hostConfig: z.record(z.string(), z.unknown()).optional(),
      expect: z.string().optional(),
      timeoutSeconds: z.number().optional(),
    },
    async (args) => runServerCommand.call(ctx, args as Parameters<typeof runServerCommand.call>[1]),
  )
  server.tool(
    runTest.NAME,
    runTest.DESCRIPTION,
    { path: z.string() },
    async (args) => runTest.call(ctx, args as { path: string }),
  )
  server.tool(
    runSimPlayerPlan.NAME,
    runSimPlayerPlan.DESCRIPTION,
    { plan: z.string() },
    async (args) => runSimPlayerPlan.call(ctx, args as { plan: string }),
  )
  server.tool(
    getSimPlayerState.NAME,
    getSimPlayerState.DESCRIPTION,
    {},
    async () => getSimPlayerState.call(ctx, {}),
  )

  // -----------------------------------------------------------------
  // Subscribe handler
  // -----------------------------------------------------------------
  // The `McpServer` high-level API doesn't expose a `subscribe()` method,
  // so wire the underlying `Server.setRequestHandler` directly. We
  // accept every subscription — the resources we serve are static
  // identifiers the agent can ask about — and return `{}`. Notification
  // delivery is handled by `sendResourceUpdated` (see
  // forwardConfigChangedToResource below for the build-log path).
  server.server.setRequestHandler(SubscribeRequestSchema, async () => ({}))

  // -----------------------------------------------------------------
  // Daemon event forwarding (best-effort)
  // -----------------------------------------------------------------
  // Don't block server startup if the daemon is down — most resources
  // will surface the error per-call.
  try {
    const daemon = await requireDaemon(ctx.projectRoot)
    forwardConfigChangedToResource(server.server, daemon)
    // Bridge WS-received notifications → stdio output. Without this,
    // daemon-pushed notifications (e.g. `notifications/resources/updated`
    // for `sandstone://rebuild-state`) die in the WS receive path —
    // the SDK's typed handlers cover configChanged/log, but generic
    // resource notifications have nowhere to go.
    forwardNotificationsToStdio(daemon, server)
  } catch {
    // No daemon — agent will discover this when it calls a resource.
  }

  return server
}

/**
 * Start the MCP server on stdio. Blocks until stdin closes.
 */
export async function runMcpServer(opts: { path: string; version: string }): Promise<void> {
  const server = await buildMcpServer(opts)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // `server.connect()` resolves once the transport is wired. The SDK
  // keeps the process alive while the transport is open — stdio closes
  // when the parent (Claude Code) disconnects, at which point
  // `server.close()` is called via the SDK's lifecycle hook. Nothing
  // for us to await here.
}

/**
 * Coerce the string-keyed `params` map from a URI template expansion
 * into a typed number-bearing shape for the build/test log readers.
 * All six params are required per the `ReadBuildLogParams` contract;
 * `-1` is the sentinel for "no filter applied". Falls back to `-1` if
 * a value is missing/unparseable so the SDK's strict matching still
 * doesn't crash.
 */
function coerceLogParams(params: Record<string, string | string[] | undefined>): {
  tail: number
  maxLines: number
  from: number
  to: number
  since: number
  until: number
} {
  const num = (v: string | string[] | undefined, fallback: number): number => {
    if (typeof v !== 'string') return fallback
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    tail: num(params.tail, -1),
    maxLines: num(params.maxLines, -1),
    from: num(params.from, -1),
    to: num(params.to, -1),
    since: num(params.since, -1),
    until: num(params.until, -1),
  }
}

/**
 * Coerce params for the file-based log readers (client/server).
 * Three params; `-1` = "no filter".
 */
function coerceFileLogParams(params: Record<string, string | string[] | undefined>): {
  tail: number
  from: number
  to: number
} {
  const num = (v: string | string[] | undefined, fallback: number): number => {
    if (typeof v !== 'string') return fallback
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    tail: num(params.tail, -1),
    from: num(params.from, -1),
    to: num(params.to, -1),
  }
}