/**
 * Update-check indicator component for ink-based TUI rendering.
 *
 * Shows a spinner during the check, then either stays silent (no updates)
 * or prints the executable update commands. Caller awaits the result of
 * `runAllUpdateChecks()` and feeds it via the `state` prop — the component
 * re-renders accordingly.
 *
 * Designed to live next to the build/watch output without interrupting it.
 *
 * Conversion from AggregatedCheck to IndicatorState lives in `updateCheck.ts`
 * (`aggregateToLines`) so non-React callers can reuse it.
 */

import React from 'react'
import { Box, Text } from 'ink'
import { clipAnsi, useTerminalColumns } from './ansi.js'

export type IndicatorState =
  | { kind: 'silent' } // resolved but nothing to show (or still pending)
  | { kind: 'commands'; lines: string[] } // resolved with updates

interface IndicatorProps {
  state: IndicatorState
}

export function UpdateCheckIndicator({ state }: IndicatorProps) {
  const cols = useTerminalColumns()
  if (state.kind === 'silent') {
    return null
  }
  // commands — clip each command line to terminal width, accounting for
  // the "  $ " indent (3 cols) so long `pnpm install …` doesn't wrap.
  const indent = 3
  const budget = Math.max(10, cols - indent)
  return (
    <Box flexDirection="column">
      <Text color="yellow">⚠ Updates available — run:</Text>
      {state.lines.map((line, i) => (
        <Text key={i}>  <Text color="green">$</Text> {clipAnsi(line, 0, budget, '…')}</Text>
      ))}
    </Box>
  )
}
