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

export type IndicatorState =
	| { kind: 'silent' } // resolved but nothing to show (or still pending)
	| { kind: 'commands'; lines: string[] } // resolved with updates

interface IndicatorProps {
	state: IndicatorState
}

export function UpdateCheckIndicator({ state }: IndicatorProps) {
	if (state.kind === 'silent') {
		return null
	}
	// commands
	return (
		<Box flexDirection="column">
			<Text color="yellow">⚠ Updates available — run:</Text>
			{state.lines.map((line, i) => (
				<Text key={i}>  <Text color="green">$</Text> {line}</Text>
			))}
		</Box>
	)
}
