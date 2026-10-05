import { DaemonUnavailableError } from '../daemon-client.js'
import { type McpBridge } from '../bridge.js'
import { raceAbort } from './_raceAbort.js'
import type { SetBuildModeParams, SetBuildModeResult } from '../../commands/connect/rpc.js'

export const NAME = 'setBuildMode'

export const DESCRIPTION =
  'Flip the running watcher\'s build mode. Pass mode `test` to enter tests-mode — every subsequent build runs with `--test` and triggers a `sand test` run after the daemon reloads. Pass mode `normal` to leave tests-mode so future builds skip the test pass. No-op when the watcher is already in the requested mode. Returns the daemon\'s broadcast acknowledgement.'

export async function call(
  bridge: McpBridge,
  args: SetBuildModeParams,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const work = (async () => {
    try {
      const result = await bridge.withDaemon((client) => client.setBuildMode(args))
      return {
        content: [{
          type: 'text' as const,
          text: result.applied
            ? `Build mode set to ${args.mode}.`
            : `Build mode change to ${args.mode} was not applied.`,
        }],
      }
    } catch (err) {
      if (err instanceof DaemonUnavailableError) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'No `sand connect` daemon is running, so there is no watcher to reconfigure.' }],
        }
      }
      throw err
    }
  })()
  return raceAbort(work, signal)
}

