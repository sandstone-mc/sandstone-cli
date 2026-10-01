/**
 * `getSimPlayerState` tool — backend not implemented yet.
 */

import type { McpBridge } from '../bridge.js'

export const NAME = 'getSimPlayerState'
export const DESCRIPTION =
  'Query the simPlayer runtime state. SimPlayer backend not implemented yet.'

export async function call(
  _bridge: McpBridge,
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: 'getSimPlayerState backend is not implemented yet. SimPlayer runtime is being designed.',
    }],
  }
}