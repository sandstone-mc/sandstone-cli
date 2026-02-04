import React, { useState, useCallback, useEffect } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import Spinner from 'ink-spinner'
import { format } from 'util'
import type { WatchStatus, TrackedChange, BuildResult, ResourceCounts, WatchUIAPI, ChangeCategory } from './types.js'
import { drainLiveLogBuffer } from './logger.js'

const TOTAL_HEIGHT = 16
const LOG_LINES = 5
const ERROR_LINES = 8

interface WatchUIProps {
  manual: boolean
  onManualRebuild?: () => void
  exit?: () => void
}

function formatTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m ago`
}

function formatChangedFiles(files: TrackedChange[]): string {
  if (files.length === 0) return 'No recent changes'
  const paths = files.map(f => f.path.split(/[/\\]/).pop() || f.path)
  if (paths.length <= 3) return paths.join(', ')
  return `${paths.slice(0, 3).join(', ')} +${paths.length - 3} more`
}

function groupByCategory(files: TrackedChange[]): Record<ChangeCategory, string[]> {
  const groups: Record<ChangeCategory, string[]> = {
    src: [],
    resources: [],
    config: [],
    dependencies: [],
    other: [],
  }
  for (const file of files) {
    const name = file.path.split(/[/\\]/).pop() || file.path
    groups[file.category].push(name)
  }
  return groups
}

function EmptyLine() {
  return <Text> </Text>
}

interface StatusLineProps {
  status: WatchStatus
  reason?: string
}

function StatusLine({ status, reason }: StatusLineProps) {
  const statusText: Record<WatchStatus, string> = {
    watching: 'Watching for changes...',
    building: 'Building...',
    restarting: 'Restarting...',
    error: 'Build Error',
    pending: 'Pending changes',
  }

  const showSpinner = status === 'building' || status === 'restarting'
  const statusColor = status === 'error' ? 'red' : status === 'pending' ? 'yellow' : 'green'

  return (
    <Text>
      {showSpinner && (
        <>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text> </Text>
        </>
      )}
      <Text color={statusColor}>{statusText[status]}</Text>
      {reason && <Text color="gray"> ({reason})</Text>}
    </Text>
  )
}

interface LogDisplayProps {
  lines: string[]
  scrollOffset: number
}

function LogDisplay({ lines, scrollOffset }: LogDisplayProps) {
  const visibleLines = lines.slice(lines.length - (scrollOffset + LOG_LINES), lines.length - scrollOffset)
  const hasMore = lines.length > LOG_LINES
  const canScrollUp = scrollOffset < (lines.length - 1)
  const canScrollDown = scrollOffset > 0

  return (
    <>
      {Array.from({ length: LOG_LINES - visibleLines.length }).map((_, i) => (
        <Text key={`empty-${i}`}> </Text>
      ))}
      {visibleLines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      {hasMore && (
        <Text color="gray">
          {canScrollUp && '▲'}{canScrollDown && '▼'} ({lines.length - LOG_LINES - scrollOffset}-{lines.length - scrollOffset}/{lines.length})
        </Text>
      )}
    </>
  )
}

interface ErrorDisplayProps {
  error: string
  scrollOffset: number
}

function ErrorDisplay({ error, scrollOffset }: ErrorDisplayProps) {
  const lines = error.split('\n')
  const visibleLines = lines.slice(scrollOffset, scrollOffset + ERROR_LINES)
  const hasMore = lines.length > ERROR_LINES
  const canScrollUp = scrollOffset > 0
  const canScrollDown = scrollOffset + ERROR_LINES < lines.length

  return (
    <>
      {visibleLines.map((line, i) => (
        <Text key={i} color="red">{line || ' '}</Text>
      ))}
      {/* Fill remaining lines if error is short */}
      {Array.from({ length: ERROR_LINES - visibleLines.length }).map((_, i) => (
        <Text key={`empty-${i}`}> </Text>
      ))}
      {hasMore && (
        <Text color="gray">
          {canScrollUp && '▲'}{canScrollDown && '▼'} ({scrollOffset + 1}-{Math.min(scrollOffset + ERROR_LINES, lines.length)}/{lines.length})
        </Text>
      )}
    </>
  )
}

interface ManualChangesDisplayProps {
  changes: TrackedChange[]
}

function ManualChangesDisplay({ changes }: ManualChangesDisplayProps) {
  const groups = groupByCategory(changes)
  const categoryLabels: Record<ChangeCategory, string> = {
    src: 'src',
    resources: 'resources',
    config: 'config',
    dependencies: 'dependencies',
    other: 'other',
  }

  const nonEmpty = Object.entries(groups).filter(([, files]) => files.length > 0) as [ChangeCategory, string[]][]

  return (
    <>
      <Text bold>Changes by category:</Text>
      {nonEmpty.map(([category, files]) => (
        <Text key={category}>
          <Text color="cyan">  {categoryLabels[category]}: </Text>
          <Text>{files.slice(0, 3).join(', ')}{files.length > 3 ? ` +${files.length - 3} more` : ''}</Text>
          {category === 'dependencies' && <Text color="yellow"> (restart required)</Text>}
        </Text>
      ))}
      {nonEmpty.length === 0 && <Text color="gray">  No changes tracked</Text>}
    </>
  )
}

interface ResourceCountsDisplayProps {
  counts: ResourceCounts | null
}

function ResourceCountsDisplay({ counts }: ResourceCountsDisplayProps) {
  if (!counts) return <Text color="gray">No build results yet</Text>
  return (
    <Text>
      <Text color="cyan">{counts.functions}</Text> functions | <Text color="cyan">{counts.other}</Text> others
    </Text>
  )
}

export function WatchUI({ manual, onManualRebuild, exit }: WatchUIProps) {
  const [status, setStatusState] = useState<WatchStatus>(manual ? 'pending' : 'watching')
  const [reason, setReason] = useState<string>()
  const [changedFiles, setChangedFilesState] = useState<TrackedChange[]>([])
  const [buildResult, setBuildResultState] = useState<BuildResult | null>(null)
  const [logLines, setLogLinesState] = useState<string[]>([])
  const [, setLiveLogState] = useState<{ level: string | false; args: unknown[] } | null>(null)
  const [logScrollOffset, setLogScrollOffset] = useState(0)
  const [errorScrollOffset, setErrorScrollOffset] = useState(0)
  const [, setTick] = useState(0)

  // Force re-render every second to update "time since" display
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  // Reset error scroll when error changes
  useEffect(() => {
    setErrorScrollOffset(0)
  }, [buildResult?.error])

  const setStatus = useCallback((newStatus: WatchStatus, newReason?: string) => {
    setStatusState(newStatus)
    setReason(newReason)
  }, [])

  const setChangedFiles = useCallback((files: TrackedChange[]) => {
    setChangedFilesState(files)
  }, [])

  const setBuildResult = useCallback((result: BuildResult) => {
    setBuildResultState(result)
    if (result.success) {
      setStatusState(manual ? 'pending' : 'watching')
    } else {
      setStatusState('error')
    }
  }, [manual])

  const setLiveLog = useCallback((level: string | false, args: unknown[]) => {
    setLiveLogState({ level, args })
    const formatted = format(...args).split('\n')
    setLogLinesState((prev) => {
      prev.push(
        `> ${(level !== false ? `[${level}] ` : '')} ${formatted[0]}`,
        ...formatted.slice(1).map((line) => `> ${line}`)
      )
      return prev
    })
  }, [])

  // Handle keyboard input
  useInput((input, key) => {
    if (input === 'q') {
      exit!()
    }
    if (status === 'error' && buildResult?.error) {
      const lines = buildResult.error.split('\n')
      if (key.upArrow) {
        setErrorScrollOffset(prev => Math.max(0, prev - 1))
      } else if (key.downArrow) {
        setErrorScrollOffset(prev => Math.min(lines.length - ERROR_LINES, prev + 1))
      }
    } else if (logLines.length > 5) {
      if (key.upArrow) {
        setLogScrollOffset(prev => Math.min(logLines.length - LOG_LINES, prev + 1))
      } else if (key.downArrow) {
        setLogScrollOffset(prev => Math.max(0, prev - 1))
      }
    }

    if (manual && status === 'pending') {
      if (input === 'r' || key.return) {
        onManualRebuild?.()
      }
    }
  })

  // Expose API via ref-like pattern
  useEffect(() => {
    const api: WatchUIAPI = {
      setStatus,
      setChangedFiles,
      setBuildResult,
      setLiveLog,
    }
    // Store in global for access from watch.ts
    ;(globalThis as Record<string, unknown>).__watchUIAPI = api
    // Drain any logs that were buffered before the API was ready
    drainLiveLogBuffer()
    return () => {
      delete (globalThis as Record<string, unknown>).__watchUIAPI
    }
  }, [setStatus, setChangedFiles, setBuildResult, setLiveLog])

  const isError = status === 'error' && buildResult?.error
  const isManualPending = manual && status === 'pending' && changedFiles.length > 0

  // Render different layouts based on state
  if (isError) {
    // Error layout - maximize error visibility
    return (
      <Box flexDirection="column" height={TOTAL_HEIGHT}>
        {/* Line 1: Header */}
        <Text bold color="yellow">Watch Mode</Text>
        {/* Line 2: Status */}
        <StatusLine status={status} reason={reason} />
        {/* Line 3: Empty */}
        <EmptyLine />
        {/* Lines 4-11: Error (8 lines) */}
        <ErrorDisplay error={buildResult.error!} scrollOffset={errorScrollOffset} />
        {/* Line 12: Empty */}
        <EmptyLine />
        {/* Line 13: Changed files */}
        <Text color="gray">Changed: {formatChangedFiles(changedFiles)}</Text>
        {/* Line 14: Empty */}
        <EmptyLine />
        {/* Line 15: Waiting message */}
        <Text color="yellow">Waiting for changes to retry...</Text>
        {/* Line 16: Footer */}
        <Text color="gray">↑↓ scroll error, Press Q to exit</Text>
      </Box>
    )
  }

  if (isManualPending) {
    // Manual mode with pending changes
    return (
      <Box flexDirection="column" height={TOTAL_HEIGHT}>
        {/* Line 1: Header */}
        <Text bold color="yellow">Watch Mode <Text color="cyan">(Manual)</Text></Text>
        {/* Line 2: Status */}
        <StatusLine status={status} reason={reason} />
        {/* Line 3: Empty */}
        <EmptyLine />
        {/* Lines 4-8: Changes by category */}
        <ManualChangesDisplay changes={changedFiles} />
        {/* Line 9: Empty */}
        <EmptyLine />
        {/* Line 10: Resource counts */}
        <ResourceCountsDisplay counts={buildResult?.resourceCounts ?? null} />
        {/* Line 11: Time since last build */}
        <Text color="gray">
          Last build: {buildResult ? formatTime(buildResult.timestamp) : 'No builds yet'}
        </Text>
        {/* Lines 12-15: Reserved */}
        <EmptyLine />
        <EmptyLine />
        <EmptyLine />
        <EmptyLine />
        {/* Line 16: Footer */}
        <Text color="gray">Press R/Enter to rebuild, Press Q to exit</Text>
      </Box>
    )
  }

  // Normal/watching layout
  return (
    <Box flexDirection="column" height={TOTAL_HEIGHT}>
      <Text bold color="yellow">Watch Mode {manual ? <Text color="cyan"> (Manual)</Text> : ''}</Text>
      <StatusLine status={status} reason={reason} />
      <EmptyLine />
      <LogDisplay lines={logLines} scrollOffset={logScrollOffset} />
      <EmptyLine />
      <Text color="gray">Changed: {formatChangedFiles(changedFiles)}</Text>
      <EmptyLine />
      <ResourceCountsDisplay counts={buildResult?.resourceCounts ?? null} />
      <Text color="gray">
        Last build: {buildResult ? formatTime(buildResult.timestamp) : 'No builds yet'}
      </Text>
      <EmptyLine />
      <Text color="gray">{manual ? 'Press R/Enter to rebuild, ' : ''}{logLines.length > 5 ? '↑↓ scroll build log, ' : ''}Press Q to exit</Text>
    </Box>
  )
}

export function getWatchUIAPI(): WatchUIAPI | undefined {
  return (globalThis as Record<string, unknown>).__watchUIAPI as WatchUIAPI | undefined
}
