/**
 * `runSimPlayerPlan` tool — backend not implemented yet.
 *
 * SimPlayer is the planned headless Minecraft runtime for in-process
 * datapack testing. No backend exists yet.
 */

import type { McpBridge } from '../bridge.js'

export const NAME = 'runSimPlayerPlan'
export const DESCRIPTION =
  'Execute a simPlayer automation plan. SimPlayer backend not implemented yet.'

export async function call(
  _bridge: McpBridge,
  _args: { plan: string },
  _signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: 'runSimPlayerPlan backend is not implemented yet. SimPlayer runtime is being designed; this tool will work once it ships.',
    }],
  }
}