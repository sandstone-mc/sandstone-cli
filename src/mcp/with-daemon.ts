/**
 * MCP daemon wrapper. `withDaemon(ctx, fn)` resolves the project's
 * `sand connect` daemon (throwing `DaemonUnavailableError` when it
 * isn't running) and passes the typed `Client` to `fn`. Catches
 * unexpected errors and formats them as MCP-shape data via
 * `mcpErrorData`. Resources / tools / handlers can focus on the
 * happy-path body.
 */

import { DaemonUnavailableError, mcpErrorData, type McpContext } from './daemon-client.js'
import type { Client } from '../commands/connect/client.js'

export { DaemonUnavailableError } from './daemon-client.js'
export { mcpErrorData } from './daemon-client.js'

/**
 * Wrap an MCP resource/tool body with daemon resolution + error
 * formatting. `fn` may return any value — it is returned verbatim
 * on success. On `daemonUnavailableError`, the same error is
 * re-thrown (the MCP SDK maps it to a protocol-level error). On any
 * other thrown error, the body is wrapped in `mcpErrorData(err)`
 * and re-thrown as a single-line `Error`.
 *
 * Usage:
 *
 *   export async function read(ctx, params) {
 *     return withDaemon(ctx, async (daemon) => {
 *       const r = await daemon.readBuildLog(...)
 *       return { uri, mimeType, text: ... }
 *     })
 *   }
 */
export async function withDaemon<T>(
  ctx: McpContext,
  fn: (daemon: Client) => Promise<T>,
): Promise<T> {
  const daemon = await requireDaemonSafe(ctx)
  try {
    return await fn(daemon)
  } catch (err) {
    if (err instanceof DaemonUnavailableError) throw err
    const data = mcpErrorData(err)
    const message = typeof data.message === 'string' ? data.message : String(err)
    throw new Error(message)
  }
}

async function requireDaemonSafe(ctx: McpContext): Promise<Client> {
  const { requireDaemon } = await import('./daemon-client.js')
  return requireDaemon(ctx.projectRoot)
}