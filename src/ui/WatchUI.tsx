import React, { useState, useCallback, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import Spinner from 'ink-spinner'
import { format } from 'util'
import type { WatchStatus, TrackedChange, BuildResult, WatchUIAPI, ChangeCategory } from './types.js'
import { drainLiveLogBuffer } from './logger.js'
import { UpdateCheckIndicator, type IndicatorState } from './UpdateCheckIndicator.jsx'
import { getMCHeaderAsync, runAllUpdateChecks, aggregateToLines } from '../utils/updateCheck.js'
import { useTerminalColumns, clipAnsi, displayWidth } from './ansi.js'

const MAX_CONTENT_LINES = 8

interface WatchUIProps {
  manual: boolean
  onManualRebuild?: () => void
  exit?: () => void
  cwd?: string
  /**
   * Called when the user presses `u` while update commands are available.
   * The parent (watch.ts) is responsible for cancelling the watcher,
   * spawning the commands, then exiting.
   */
  onRunUpdates?: (commands: string[]) => void
}

/**
 * Join file basenames into a width-budgeted summary. Uses display columns
 * (not char count) so ANSI codes and emoji don't blow the budget. When the
 * budget runs out mid-name, the last visible entry is clipped with '…' and
 * a `+N more` suffix is appended.
 */
function formatChangedFiles(files: TrackedChange[], budget: number): string {
  if (files.length === 0) return 'No recent changes'
  const names = files.map(f => f.path.split(/[/\\]/).pop() || f.path)
  const sep = ', '
  const sepW = displayWidth(sep)
  let used = 0
  const parts: string[] = []
  let overflowStart = -1
  for (let i = 0; i < names.length; i++) {
    const w = displayWidth(names[i])
    const addition = (parts.length > 0 ? sepW : 0) + w
    if (used + addition > budget) {
      overflowStart = i
      break
    }
    parts.push(names[i])
    used += addition
  }
  if (overflowStart >= 0) {
    const suffix = ` +${names.length - overflowStart} more`
    const suffixW = displayWidth(suffix)
    const remaining = budget - used - sepW - suffixW
    const clipped = remaining > 1 ? clipAnsi(names[overflowStart], 0, remaining, '…') : '…'
    parts.push(clipped)
    return `${parts.join(sep)}${suffix}`
  }
  return parts.join(sep)
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
  /** Effective number of lines this display may occupy. May be < MAX when
   *  the parent reserves space for an MC header + update commands. */
  maxLines: number
  /** Terminal width. Each rendered line is clipped to this width so long
   *  log/error/file lines don't blow past the visible area. */
  cols: number
}

/** Build a width-budgeted `a, b, c +N more` summary for one category. */
function buildFileList(names: string[], budget: number): string {
  const sep = ', '
  const sepW = displayWidth(sep)
  let used = 0
  const parts: string[] = []
  let overflowStart = -1
  for (let i = 0; i < names.length; i++) {
    const w = displayWidth(names[i])
    const addition = (parts.length > 0 ? sepW : 0) + w
    if (used + addition > budget) {
      overflowStart = i
      break
    }
    parts.push(names[i])
    used += addition
  }
  if (overflowStart >= 0) {
    const suffix = ` +${names.length - overflowStart} more`
    const suffixW = displayWidth(suffix)
    const remaining = budget - used - sepW - suffixW
    const clipped = remaining > 1 ? clipAnsi(names[overflowStart], 0, remaining, '…') : '…'
    parts.push(clipped)
    return `${parts.join(sep)}${suffix}`
  }
  return parts.join(sep)
}

function ContentDisplay({ mode, logLines, errorText, changes, scrollOffset, maxLines, cols }: ContentDisplayProps) {
  let contentData: { text: string; color?: string }[] = []

  if (mode === 'error' && errorText) {
    contentData = errorText.split('\n').map(line => ({ text: line ? clipAnsi(line, 0, cols, '…') : ' ', color: 'red' }))
  } else if (mode === 'changes') {
    const groups = groupByCategory(changes)
    const nonEmpty = Object.entries(groups).filter(([, files]) => files.length > 0) as [ChangeCategory, string[]][]

    contentData.push({ text: 'Changes by category:', color: undefined })
    for (const [category, files] of nonEmpty.slice(0, 4)) {
      const suffix = category === 'dependencies' ? ' (restart required)' : ''
      const prefix = `  ${categoryLabels[category]}: `
      const prefixW = displayWidth(prefix) + displayWidth(suffix)
      const fileList = buildFileList(files, cols - prefixW)
      contentData.push({ text: `${prefix}${fileList}${suffix}`, color: 'cyan' })
    }
    if (nonEmpty.length === 0) {
      contentData.push({ text: '  No changes tracked', color: 'gray' })
    }
  } else {
    contentData = logLines.map(line => ({ text: clipAnsi(line, 0, cols, '…') }))
  }

  const totalLines = contentData.length
  const height = Math.max(1, maxLines)
  const hasMore = totalLines > height

  let visibleLines: { text: string; color?: string }[]
  let scrollInfo = ''

  if (mode === 'logs') {
    const start = Math.max(0, totalLines - scrollOffset - height)
    const end = Math.max(0, totalLines - scrollOffset)
    visibleLines = contentData.slice(start, end)
    if (hasMore) {
      const canUp = scrollOffset < totalLines - height
      const canDown = scrollOffset > 0
      scrollInfo = `${canUp ? '▲' : ''}${canDown ? '▼' : ''} (${start + 1}-${end}/${totalLines})`
    }
  } else {
    visibleLines = contentData.slice(scrollOffset, scrollOffset + height)
    if (hasMore) {
      const canUp = scrollOffset > 0
      const canDown = scrollOffset + height < totalLines
      scrollInfo = `${canUp ? '▲' : ''}${canDown ? '▼' : ''} (${scrollOffset + 1}-${scrollOffset + visibleLines.length}/${totalLines})`
    }
  }

  const padding = height - visibleLines.length
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

export function WatchUI({ manual, onManualRebuild, exit, cwd, onRunUpdates }: WatchUIProps) {
  const [status, setStatusState] = useState<WatchStatus>(manual ? 'pending' : 'watching')
  const [reason, setReason] = useState<string>()
  const [changedFiles, setChangedFilesState] = useState<TrackedChange[]>([])
  const [buildResult, setBuildResultState] = useState<BuildResult | null>(null)
  const [logLines, setLogLinesState] = useState<string[]>([])
  const [scrollOffset, setScrollOffset] = useState(0)
  const [mcHeader, setMcHeader] = useState<string | null>(null)
  const [updateCheckState, setUpdateCheckState] = useState<IndicatorState>({ kind: 'silent' })
  const cols = useTerminalColumns()

  const isError = status === 'error' && buildResult?.error
  const isManualPending = manual && status === 'pending' && changedFiles.length > 0
  const contentMode = isError ? 'error' : isManualPending ? 'changes' : 'logs'

  useEffect(() => {
    setScrollOffset(0)
  }, [contentMode, buildResult?.error])

  // Kick off MC header + update check once at mount; results awaited asynchronously.
  useEffect(() => {
    if (!cwd) return
    let cancelled = false
    void getMCHeaderAsync(cwd).then((h) => {
      if (!cancelled) setMcHeader(h)
    })
    void runAllUpdateChecks(cwd).then((agg) => {
      if (cancelled) return
      const lines = aggregateToLines(agg)
      setUpdateCheckState(lines.length > 0 ? { kind: 'commands', lines } : { kind: 'silent' })
    }).catch(() => {
      if (!cancelled) setUpdateCheckState({ kind: 'silent' })
    })
    return () => {
      cancelled = true
    }
  }, [cwd])

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
      // Clear changed files so contentMode switches back to 'logs'
      setChangedFilesState([])
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

  // Reserve space for elements above the content area to keep total line
  // count stable when an MC header or update-commands appear or disappear.
  const extraReservedLines =
    (mcHeader ? 1 : 0) +
    (updateCheckState.kind === 'commands' ? 1 + updateCheckState.lines.length : 0)
  const effectiveContentLines = Math.max(2, MAX_CONTENT_LINES - extraReservedLines)

  const getMaxScroll = useCallback(() => {
    if (isError && buildResult?.error) {
      return Math.max(0, buildResult.error.split('\n').length - effectiveContentLines)
    } else if (isManualPending) {
      return 0
    } else {
      return Math.max(0, logLines.length - effectiveContentLines)
    }
  }, [isError, isManualPending, buildResult?.error, logLines.length, effectiveContentLines])

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit!()
    }

    // [u] — run the pending update commands. Parent cancels the watcher,
    // spawns each command, then exits. No-op when no updates are available.
    if (input === 'u' && updateCheckState.kind === 'commands') {
      const lines = updateCheckState.lines
      onRunUpdates?.(lines)
    }

    const maxScroll = getMaxScroll()
    if (key.upArrow) {
      if (isError) {
        setScrollOffset(prev => Math.max(0, prev - 1))
      } else {
        setScrollOffset(prev => Math.min(maxScroll, prev + 1))
      }
    } else if (key.downArrow) {
      if (isError) {
        setScrollOffset(prev => Math.min(maxScroll, prev + 1))
      } else {
        setScrollOffset(prev => Math.max(0, prev - 1))
      }
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
      exit: () => exit!(),
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
  if (logLines.length > effectiveContentLines || (isError && buildResult?.error && buildResult.error.split('\n').length > effectiveContentLines)) {
    footerParts.push('↑↓: scroll')
  }
  footerParts.push('U: update+exit')
  footerParts.push('Q: exit')

  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        Watch Mode{manual ? <Text color="cyan"> (Manual)</Text> : ''}
      </Text>

      {mcHeader && <Text color="gray">{mcHeader}</Text>}
      <UpdateCheckIndicator state={updateCheckState} />

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
        maxLines={effectiveContentLines}
        cols={cols}
      />

      <Text> </Text>

      <Text color="gray">Changed: {formatChangedFiles(changedFiles, Math.max(10, cols - 'Changed: '.length))}</Text>

      {buildResult?.resourceCounts ? (
        <Text>
          <Text color="cyan">{buildResult.resourceCounts.functions}</Text> functions | <Text color="cyan">{buildResult.resourceCounts.other}</Text> others
        </Text>
      ) : (
        <Text color="gray">No build results yet</Text>
      )}

      {isError ? <Text color="yellow">Waiting for changes to retry...</Text> : <Text> </Text>}

      <Text color="gray">{clipAnsi(footerParts.join(' | '), 0, cols, '…')}</Text>
    </Box>
  )
}

export function getWatchUIAPI(): WatchUIAPI | undefined {
  return (globalThis as Record<string, unknown>).__watchUIAPI as WatchUIAPI | undefined
}
