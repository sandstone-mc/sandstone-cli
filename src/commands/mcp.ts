/**
 * `sand mcp` — start a stdio MCP server for the current project.
 *
 * Designed to be invoked by an LLM agent's host (Claude Code, Cursor,
 * etc.) as a subprocess. The server speaks JSON-RPC over stdio per
 * the Model Context Protocol spec.
 *
 *   `claude mcp add sandstone-cli sand mcp -- --path /path/to/project`
 *
 * Flags:
 *   `--path <dir>` — project root (defaults to cwd). Same flag every
 *     other sand command uses.
 *
 * Output discipline: **stays strictly on stdout** for MCP messages
 * and **strictly on stderr** for human-readable progress. Anything on
 * stdout that isn't valid MCP framing breaks the protocol — the parent
 * process will see garbage.
 */

import { resolve } from 'node:path'
import { runMcpServer } from '../mcp/server.js'
import { CLI_VERSION } from '../version.js'

export interface McpCommandOptions {
  /** `--path <dir>` — project root. */
  path: string
}

export async function mcpCommand(opts: McpCommandOptions): Promise<void> {
  const projectRoot = resolve(opts.path)
  // Print the boot line on stderr so the MCP parent can ignore it
  // while the human sees progress if they piped to a terminal.
  console.error(`[mcp] starting Sandstone MCP server v${CLI_VERSION} for ${projectRoot}`)
  console.error('[mcp] capabilities: resources (subscribe), tools, logging')
  console.error('[mcp] transport: stdio')

  await runMcpServer({ path: projectRoot, version: CLI_VERSION })

  console.error('[mcp] server stopped')
}