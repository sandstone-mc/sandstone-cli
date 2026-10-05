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
import * as testState from './resources/testState.js'
import * as watcherStatus from './resources/watcherStatus.js'

import * as runWorkspaceBuild from './tools/runWorkspaceBuild.js'
import * as deployToServer from './tools/deployToServer.js'
import * as restartServer from './tools/restartServer.js'
import * as runServerCommand from './tools/runServerCommand.js'
import * as setBuildMode from './tools/setBuildMode.js'
import * as runSimPlayerPlan from './tools/runSimPlayerPlan.js'
import * as getSimPlayerState from './tools/getSimPlayerState.js'
import * as registerLogListener from './tools/registerLogListener.js'
import * as getLogListener from './tools/getLogListener.js'

import { makeContext } from './daemon-client.js'
import { McpBridge } from './bridge.js'

export async function buildMcpServer(opts: { path: string; version: string }): Promise<{ server: McpServer; bridge: McpBridge }> {
  const ctx = makeContext(opts)
  const bridge = new McpBridge(ctx)

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

  server.registerResource(
    getSaveConfig.NAME,
    getSaveConfig.URI,
    { title: getSaveConfig.NAME, description: getSaveConfig.DESCRIPTION },
    async (_uri) => {
      const r = await getSaveConfig.read(bridge)
      return { contents: [r] }
    },
  )
  server.registerResource(
    readSandstoneLog.NAME,
    new ResourceTemplate(readSandstoneLog.URI, { list: undefined }),
    { title: readSandstoneLog.NAME, description: readSandstoneLog.DESCRIPTION },
    async (_uri, params) => {
      const r = await readSandstoneLog.read(bridge, coerceLogParams(params))
      return { contents: [r] }
    },
  )
  server.registerResource(
    `${readSandstoneOutput.NAME}-root`,
    readSandstoneOutput.FIXED_URI,
    { title: `${readSandstoneOutput.NAME} root`, description: readSandstoneOutput.DESCRIPTION },
    async (_uri) => {
      const r = await readSandstoneOutput.read(bridge, '')
      return { contents: [r] }
    },
  )
  server.registerResource(
    readSandstoneOutput.NAME,
    new ResourceTemplate(readSandstoneOutput.TEMPLATE_URI, { list: undefined }),
    { title: readSandstoneOutput.NAME, description: readSandstoneOutput.DESCRIPTION },
    async (_uri, params) => {
      const path = typeof params.path === 'string' ? params.path : ''
      const r = await readSandstoneOutput.read(bridge, path)
      return { contents: [r] }
    },
  )
  server.registerResource(
    readClientLog.NAME,
    new ResourceTemplate(readClientLog.URI, { list: undefined }),
    { title: readClientLog.NAME, description: readClientLog.DESCRIPTION },
    async (_uri, params) => {
      const r = await readClientLog.read(bridge, coerceFileLogParams(params))
      return { contents: [r] }
    },
  )
  server.registerResource(
    readServerLog.NAME,
    new ResourceTemplate(readServerLog.URI, { list: undefined }),
    { title: readServerLog.NAME, description: readServerLog.DESCRIPTION },
    async (_uri, params) => {
      const r = await readServerLog.read(bridge, coerceLogParams(params))
      return { contents: [r] }
    },
  )
  server.registerResource(
    readTestLog.NAME,
    new ResourceTemplate(readTestLog.URI, { list: undefined }),
    { title: readTestLog.NAME, description: readTestLog.DESCRIPTION },
    async (_uri, params) => {
      const r = await readTestLog.read(bridge, coerceLogParams(params))
      return { contents: [r] }
    },
  )
  server.registerResource(
    rebuildState.NAME,
    rebuildState.URI,
    { title: rebuildState.NAME, description: rebuildState.DESCRIPTION },
    async (_uri) => {
      const r = await rebuildState.read(bridge)
      return { contents: [r] }
    },
  )
  server.registerResource(
    testState.NAME,
    testState.URI,
    { title: testState.NAME, description: testState.DESCRIPTION },
    async (_uri) => {
      const r = await testState.read(bridge)
      return { contents: [r] }
    },
  )
  server.registerResource(
    watcherStatus.NAME,
    watcherStatus.URI,
    { title: watcherStatus.NAME, description: watcherStatus.DESCRIPTION },
    async (_uri) => {
      const r = await watcherStatus.read(bridge)
      return { contents: [r] }
    },
  )
  server.registerTool(
    runWorkspaceBuild.NAME,
    { title: runWorkspaceBuild.NAME, description: runWorkspaceBuild.DESCRIPTION },
    async (extra) => runWorkspaceBuild.call(bridge, {}, extra.signal),
  )
  server.registerTool(
    deployToServer.NAME,
    { title: deployToServer.NAME, description: deployToServer.DESCRIPTION },
    async (extra) => deployToServer.call(bridge, {}, extra.signal),
  )
  server.registerTool(
    restartServer.NAME,
    { title: restartServer.NAME, description: restartServer.DESCRIPTION },
    async (extra) => restartServer.call(bridge, {}, extra.signal),
  )
  server.registerTool(
    runServerCommand.NAME,
    {
      title: runServerCommand.NAME,
      description: runServerCommand.DESCRIPTION,
      inputSchema: {
        command: z.string(),
        hostType: z.string().optional(),
        hostConfig: z.record(z.string(), z.unknown()).optional(),
        expect: z.string().optional(),
        waitFor: z.object({
          kind: z.enum(['endsWith', 'includes', 'glob', 'regex']),
          value: z.string(),
          timeoutMs: z.number().optional(),
          closingLine: z.object({
            kind: z.enum(['endsWith', 'includes', 'glob', 'regex']),
            value: z.string(),
            timeoutMs: z.number().optional(),
          }).optional(),
        }).optional(),
      },
    },
    async (args, extra) => runServerCommand.call(bridge, args as Parameters<typeof runServerCommand.call>[1], extra.signal),
  )
  server.registerTool(
    registerLogListener.NAME,
    {
      title: registerLogListener.NAME,
      description: registerLogListener.DESCRIPTION,
      inputSchema: {
        pattern: z.object({
          kind: z.enum(['endsWith', 'includes', 'glob', 'regex']),
          value: z.string(),
          timeoutMs: z.number().optional(),
          closingLine: z.object({
            kind: z.enum(['endsWith', 'includes', 'glob', 'regex']),
            value: z.string(),
            timeoutMs: z.number().optional(),
          }).optional(),
        }),
      },
    },
    async (args, extra) => registerLogListener.call(bridge, args as Parameters<typeof registerLogListener.call>[1], extra.signal),
  )
  server.registerTool(
    getLogListener.NAME,
    {
      title: getLogListener.NAME,
      description: getLogListener.DESCRIPTION,
      inputSchema: { id: z.string() },
    },
    async (args, extra) => getLogListener.call(bridge, args as { id: string }, extra.signal),
  )
  server.registerTool(
    setBuildMode.NAME,
    {
      title: setBuildMode.NAME,
      description: setBuildMode.DESCRIPTION,
      inputSchema: { mode: z.enum(['normal', 'test']) },
    },
    async (args, extra) => setBuildMode.call(bridge, args as Parameters<typeof setBuildMode.call>[1], extra.signal),
  )
  server.registerTool(
    runSimPlayerPlan.NAME,
    {
      title: runSimPlayerPlan.NAME,
      description: runSimPlayerPlan.DESCRIPTION,
      inputSchema: { plan: z.string() },
    },
    async (args, extra) => runSimPlayerPlan.call(bridge, args, extra.signal),
  )
  server.registerTool(
    getSimPlayerState.NAME,
    { title: getSimPlayerState.NAME, description: getSimPlayerState.DESCRIPTION },
    async (extra) => getSimPlayerState.call(bridge, {}, extra.signal),
  )
  server.server.setRequestHandler(SubscribeRequestSchema, async () => ({}))

  bridge.attachForwarders(server)

  return { server, bridge }
}

export async function runMcpServer(opts: { path: string; version: string }): Promise<void> {
  const { server, bridge } = await buildMcpServer(opts)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    transport.onclose = () => {
      bridge.dispose()
      resolve()
    }
  })
}

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