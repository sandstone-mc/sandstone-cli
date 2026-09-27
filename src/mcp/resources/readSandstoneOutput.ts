/**
 * `sandstone://build-output/{path}` — list one level of the build output tree.
 *
 * Path is relative to the mode-resolved output dir
 * (`<root>/.sandstone/output` for pack mode,
 * `<root>/test/.sandstone/output` for library mode). Returns up to
 * 1000 entries per call.
 *
 * Resource URI template: `sandstone://build-output/{+path}`
 * Format: TOML (a `[[entries]]` array — easier to read than nested
 * directories and keeps the LLM able to see the structure).
 */

import { formatConfigAsToml, sentinelizeNullish } from '../serialize-config.js'
import { requireDaemon, type McpContext } from '../daemon-client.js'

/**
 * Template URI for paths under the build output directory.
 * `{path}` matches exactly one non-empty segment (RFC 6570 simple
 * expansion). The root URI (`sandstone://build-output`, no slash) is
 * registered separately as a fixed URI because `{path}` can't match
 * zero-length — see `register()` in `mcp/server.ts`.
 */
export const TEMPLATE_URI = 'sandstone://build-output/{path}'
export const FIXED_URI = 'sandstone://build-output'
export const MIME = 'application/toml'
export const NAME = 'build-output'
export const DESCRIPTION = 'One level of the watcher\'s build output tree. Use the `path` URI segment to descend (e.g. `sandstone://build-output/datapack/data`).'

/**
 * Read at a specific subpath. Returns the entries as TOML.
 */
export async function read(ctx: McpContext, subpath = ''): Promise<{ uri: string; mimeType: string; text: string }> {
  const daemon = await requireDaemon(ctx.projectRoot)
  const tree = await daemon.getBuildOutputTree({ path: subpath, limit: 1000 })
  return {
    uri: `sandstone://build-output/${subpath}`,
    mimeType: MIME,
    text: formatConfigAsToml({
      baseDir: tree.baseDir,
      entries: tree.entries,
      truncated: tree.truncated,
    }),
  }
}

/**
 * List mode + base output directory without listing entries. Useful for
 * clients that want a quick overview.
 */
export async function summary(ctx: McpContext): Promise<{ uri: string; mimeType: string; text: string }> {
  const daemon = await requireDaemon(ctx.projectRoot)
  const active = await daemon.getActiveConfig()
  return {
    uri: 'sandstone://build-output',
    mimeType: MIME,
    text: formatConfigAsToml(sentinelizeNullish({
      mode: active.mode,
      outputDir: active.outputDir,
    })),
  }
}