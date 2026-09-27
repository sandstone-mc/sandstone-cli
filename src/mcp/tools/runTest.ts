/**
 * `runTest` tool — backend not implemented yet.
 */

import type { McpContext } from '../daemon-client.js'

export const NAME = 'runTest'
export const DESCRIPTION =
  'Run a test file. Backend not implemented yet — there is no test runner wired into the CLI today. Tracking issue: TBD.'

export async function call(
  _ctx: McpContext,
  _args: { path: string },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: 'runTest backend is not implemented yet. The test runner is being built; this tool will return an actionable error until it ships.',
    }],
  }
}