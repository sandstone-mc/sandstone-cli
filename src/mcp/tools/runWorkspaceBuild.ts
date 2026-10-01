/**
 * `runWorkspaceBuild` tool.
 *
 * Triggers a `sand build` ONLY when a watcher is connected in **manual
 * mode** — that's the only state where the user explicitly opts in to
 * push-driven builds. Pair with `resources/subscribe
 * sandstone://rebuild-state` to see the start/finish events.
 *
 * Why three branches:
 *   - **Watcher connected + manual**: rebuild makes sense. Fire the
 *     trigger via the daemon; the watcher consumes pending changes and
 *     rebuilds. Returns immediately; the result lives on
 *     `sandstone://rebuild-state`.
 *   - **Watcher connected + auto**: rebuild is wasted — the watcher
 *     already rebuilds on every file change. Surface that as an
 *     `isError: true` result with a clear "the watcher handles this"
 *     message.
 *   - **No watcher**: the project has no build pipeline. Error and
 *     tell the agent to use the `sand build` Bash command directly.
 *
 * Pair this with `resources/subscribe sandstone://rebuild-state` —
 * the trigger returns immediately; the build result lives on the
 * `rebuild-state` resource as `complete` / `failed` events.
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { type McpBridge } from '../bridge.js'

export const NAME = 'runWorkspaceBuild'

export const DESCRIPTION =
  'Trigger a `sand build`. USAGE: only useful when a `sand watch` is connected in **manual mode** (changes queue until you trigger). ' +
  'If the watcher is in auto-rebuild mode, this returns an error — the watcher already rebuilds on every file change, no need to push. ' +
  'If no watcher is connected, this returns an error — use the `sand build` Bash command directly. ' +
  'Pairs with subscribing to `sandstone://rebuild-state` for the build result; this tool returns immediately when the trigger is accepted and exactly one notification fires per build (when it completes or fails).'

export async function call(
  bridge: McpBridge,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const daemon = await bridge.requireDaemon()

  // Need watcher status to decide the branch. We can't proceed without
  // it — surface a clean error if the daemon refuses to answer.
  let watcherStatus
  try {
    watcherStatus = (await daemon.getWatcherStatus()).status
  } catch (err) {
    throw new McpError(ErrorCode.InternalError, `Failed to query watcher status: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Branch 3: no watcher has connected.
  if (watcherStatus === null) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          'No `sand watch` is currently connected to this project.\n\n' +
          '`runWorkspaceBuild` only works when a watcher is running in manual mode. ' +
          'If you want a one-shot build without a watcher, run `sand build` via the Bash tool — it will succeed without any daemon wiring.',
      }],
    }
  }

  // Branch 2: watcher is connected but in auto-rebuild mode.
  if (!watcherStatus.manual) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `Watcher is connected in auto-rebuild mode (${watcherStatus.mode}) — it already rebuilds on every source change, so triggering manually is wasted work.\n\n` +
          `If you need to force a rebuild despite no pending changes (rare), restart the watcher with \`--manual\`. ` +
          `Otherwise, just edit a source file and the watcher handles it.`,
      }],
    }
  }

  // Branch 1: watcher connected + manual. Trigger and return.
  try {
    await daemon.publishTriggerBuild()
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to trigger build: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return {
    content: [{
      type: 'text',
      text:
        'Build triggered. The watcher will consume any pending changes and rebuild.\n\n' +
        'Subscribe to `sandstone://rebuild-state` to see the build result (started → complete/failed with file counts and any error).',
    }],
  }
}