import React, { useState, useCallback, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import Spinner from 'ink-spinner'
import { format } from 'util'
import type { WatchStatus, TrackedChange, BuildResult, WatchUIAPI, ChangeCategory } from './types.js'
import { drainLiveLogBuffer } from './logger.js'

const CONTENT_LINES = 8

interface WatchUIProps {
  manual: boolean
  onManualRebuild?: () => void
  exit?: () => void
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

const categoryLabels: Record<ChangeCategory, string> = {
  src: 'src',
  resources: 'resources',
  config: 'config',
  dependencies: 'dependencies',
  other: 'other',
}

interface ContentDisplayProps {
  mode: 'logs' | 'error' | 'changes'
  logLines: string[]
  errorText: string | null
  changes: TrackedChange[]
  scrollOffset: number
}

function ContentDisplay({ mode, logLines, errorText, changes, scrollOffset }: ContentDisplayProps) {
  let contentData: { text: string; color?: string }[] = []

  if (mode === 'error' && errorText) {
    contentData = errorText.split('\n').map(line => ({ text: line || ' ', color: 'red' }))
  } else if (mode === 'changes') {
    const groups = groupByCategory(changes)
    const nonEmpty = Object.entries(groups).filter(([, files]) => files.length > 0) as [ChangeCategory, string[]][]

    contentData.push({ text: 'Changes by category:', color: undefined })
    for (const [category, files] of nonEmpty.slice(0, 4)) {
      const fileList = files.slice(0, 3).join(', ') + (files.length > 3 ? ` +${files.length - 3} more` : '')
      const suffix = category === 'dependencies' ? ' (restart required)' : ''
      contentData.push({ text: `  ${categoryLabels[category]}: ${fileList}${suffix}`, color: 'cyan' })
    }
    if (nonEmpty.length === 0) {
      contentData.push({ text: '  No changes tracked', color: 'gray' })
    }
  } else {
    contentData = logLines.map(line => ({ text: line }))
  }

  const totalLines = contentData.length
  const hasMore = totalLines > CONTENT_LINES

  let visibleLines: { text: string; color?: string }[]
  let scrollInfo = ''

  if (mode === 'logs') {
    const start = Math.max(0, totalLines - scrollOffset - CONTENT_LINES)
    const end = Math.max(0, totalLines - scrollOffset)
    visibleLines = contentData.slice(start, end)
    if (hasMore) {
      const canUp = scrollOffset < totalLines - CONTENT_LINES
      const canDown = scrollOffset > 0
      scrollInfo = `${canUp ? '▲' : ''}${canDown ? '▼' : ''} (${start + 1}-${end}/${totalLines})`
    }
  } else {
    visibleLines = contentData.slice(scrollOffset, scrollOffset + CONTENT_LINES)
    if (hasMore) {
      const canUp = scrollOffset > 0
      const canDown = scrollOffset + CONTENT_LINES < totalLines
      scrollInfo = `${canUp ? '▲' : ''}${canDown ? '▼' : ''} (${scrollOffset + 1}-${scrollOffset + visibleLines.length}/${totalLines})`
    }
  }

  const padding = CONTENT_LINES - visibleLines.length
  const paddingBefore = mode === 'logs' ? padding : 0
  const paddingAfter = mode === 'logs' ? 0 : padding

  return (
    <>
      {Array.from({ length: paddingBefore }).map((_, i) => (
        <Text key={`pad-before-${i}`}> </Text>
      ))}
      {visibleLines.map((line, i) => (
        <Text key={`content-${i}`} color={line.color as any}>{line.text}</Text>
      ))}
      {Array.from({ length: paddingAfter }).map((_, i) => (
        <Text key={`pad-after-${i}`}> </Text>
      ))}
      <Text color="gray">{scrollInfo || ' '}</Text>
    </>
  )
}

export function WatchUI({ manual, onManualRebuild, exit }: WatchUIProps) {
  const [status, setStatusState] = useState<WatchStatus>(manual ? 'pending' : 'watching')
  const [reason, setReason] = useState<string>()
  const [changedFiles, setChangedFilesState] = useState<TrackedChange[]>([])
  const [buildResult, setBuildResultState] = useState<BuildResult | null>(null)
  const [logLines, setLogLinesState] = useState<string[]>([])
  const [scrollOffset, setScrollOffset] = useState(0)

  const isError = status === 'error' && buildResult?.error
  const isManualPending = manual && status === 'pending' && changedFiles.length > 0
  const contentMode = isError ? 'error' : isManualPending ? 'changes' : 'logs'

  useEffect(() => {
    setScrollOffset(0)
  }, [contentMode, buildResult?.error])

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
    const formatted = format(...args).split('\n')
    setLogLinesState((prev) => {
      const newLines = [...prev]
      newLines.push(
        `> ${level !== false ? `[${level}] ` : ''}${formatted[0]}`,
        ...formatted.slice(1).map((line) => `> ${line}`)
      )
      return newLines
    })
  }, [])

  const getMaxScroll = useCallback(() => {
    if (isError && buildResult?.error) {
      return Math.max(0, buildResult.error.split('\n').length - CONTENT_LINES)
    } else if (isManualPending) {
      return 0
    } else {
      return Math.max(0, logLines.length - CONTENT_LINES)
    }
  }, [isError, isManualPending, buildResult?.error, logLines.length])

  useInput((input, key) => {
    if (input === 'q') {
      exit!()
    }

    const maxScroll = getMaxScroll()
    if (key.upArrow) {
      setScrollOffset(prev => Math.min(maxScroll, prev + 1))
    } else if (key.downArrow) {
      setScrollOffset(prev => Math.max(0, prev - 1))
    }

    if (manual && status === 'pending') {
      if (input === 'r' || key.return) {
        onManualRebuild?.()
      }
    }
  })

  useEffect(() => {
    const api: WatchUIAPI = {
      setStatus,
      setChangedFiles,
      setBuildResult,
      setLiveLog,
    }
    ;(globalThis as Record<string, unknown>).__watchUIAPI = api
    drainLiveLogBuffer()
    return () => {
      delete (globalThis as Record<string, unknown>).__watchUIAPI
    }
  }, [setStatus, setChangedFiles, setBuildResult, setLiveLog])

  const statusText: Record<WatchStatus, string> = {
    watching: 'Watching for changes...',
    building: 'Building...',
    restarting: 'Restarting...',
    error: 'Build Error',
    pending: 'Pending changes',
  }
  const showSpinner = status === 'building' || status === 'restarting'
  const statusColor = status === 'error' ? 'red' : status === 'pending' ? 'yellow' : 'green'

  const footerParts: string[] = []
  if (manual) footerParts.push('R/Enter: rebuild')
  if (logLines.length > CONTENT_LINES || (isError && buildResult?.error && buildResult.error.split('\n').length > CONTENT_LINES)) {
    footerParts.push('↑↓: scroll')
  }
  footerParts.push('Q: exit')

  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        Watch Mode{manual ? <Text color="cyan"> (Manual)</Text> : ''}
      </Text>

      <Text>
        {showSpinner && <><Text color="cyan"><Spinner type="dots" /></Text><Text> </Text></>}
        <Text color={statusColor}>{statusText[status]}</Text>
        {reason && <Text color="gray"> ({reason})</Text>}
      </Text>

      <Text> </Text>

      <ContentDisplay
        mode={contentMode}
        logLines={logLines}
        errorText={buildResult?.error ?? null}
        changes={changedFiles}
        scrollOffset={scrollOffset}
      />

      <Text> </Text>

      <Text color="gray">Changed: {formatChangedFiles(changedFiles)}</Text>

      {buildResult?.resourceCounts ? (
        <Text>
          <Text color="cyan">{buildResult.resourceCounts.functions}</Text> functions | <Text color="cyan">{buildResult.resourceCounts.other}</Text> others
        </Text>
      ) : (
        <Text color="gray">No build results yet</Text>
      )}

      {isError ? <Text color="yellow">Waiting for changes to retry...</Text> : <Text> </Text>}

      <Text color="gray">{footerParts.join(' | ')}</Text>
    </Box>
  )
}

export function getWatchUIAPI(): WatchUIAPI | undefined {
  return (globalThis as Record<string, unknown>).__watchUIAPI as WatchUIAPI | undefined
}
