/**
 * ANSI helpers + a React hook for live terminal width.
 *
 * Uses Bun's native APIs (sliceAnsi / wrapAnsi / stringWidth / stripANSI)
 * when available — they're SIMD-fast and correctly handle emoji ZWJ,
 * hyperlinks, and ANSI across slice boundaries. When Bun is missing
 * (running tests in node, etc.) we fall back to the matching npm packages.
 *
 * `getTerminalColumns()` returns 80 when stdout is not a TTY (CI, pipes)
 * — `process.stdout.columns` is undefined there.
 */
import { useEffect, useState } from 'react'
import stringWidthPkg from 'string-width'
import wrapAnsiPkg from 'wrap-ansi'
import sliceAnsiPkg from 'slice-ansi'
import cliTruncatePkg from 'cli-truncate'
import stripAnsiPkg from 'strip-ansi'

const DEFAULT_COLUMNS = 80

export function getTerminalColumns(): number {
  return process.stdout.columns ?? DEFAULT_COLUMNS
}

/**
 * React hook: re-renders the consumer when the terminal is resized.
 * Returns the current column count (defaults to 80 if not a TTY).
 */
export function useTerminalColumns(): number {
  const [cols, setCols] = useState(getTerminalColumns)

  useEffect(() => {
    const onResize = () => setCols(getTerminalColumns())
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
    }
  }, [])

  return cols
}

/** True when Bun's native ANSI helpers are available. */
function hasBun(): boolean {
  return typeof Bun !== 'undefined' && typeof Bun.sliceAnsi === 'function'
}

/** Display column count of `text` (ANSI-aware). */
export function displayWidth(text: string): number {
  return hasBun() ? Bun.stringWidth(text) : stringWidthPkg(text)
}

export type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
  ambiguousIsNarrow?: boolean
}

/**
 * Soft-wrap `text` to `columns`, preserving ANSI across row boundaries.
 */
export function wrapAnsi(text: string, columns: number, options?: WrapAnsiOptions): string {
  return hasBun() ? Bun.wrapAnsi(text, columns, options) : wrapAnsiPkg(text, columns, options)
}

/**
 * Clip `text` to the column range `[start, end)`, preserving ANSI codes
 * and hyperlinks. When `overflowIndicator` is supplied, replaced content
 * is summarized with it (e.g. '…'). Negative `start` counts from the end.
 *
 * Bun's native impl replaces content from BOTH cut ends when `start > 0`
 * (e.g. `sliceAnsi("unicorn", 1, 4, "…")` → `"…i…"`). The npm polyfill
 * can only truncate one end at a time, so callsites that exercise that
 * edge case should run on Bun. All current callsites in this CLI use
 * `start = 0`, which is identical across both impls.
 */
export function clipAnsi(text: string, start: number, end?: number, overflowIndicator?: string): string {
  if (hasBun()) return Bun.sliceAnsi(text, start, end, overflowIndicator)
  if (overflowIndicator === undefined) {
    // slice-ansi doesn't support negative `start` — resolve before calling.
    const resolvedStart = start < 0 ? stringWidthPkg(text) + start : start
    return sliceAnsiPkg(text, resolvedStart, end)
  }
  if (start === 0 && end !== undefined) {
    // start=0 with overflow → exact equivalent of `cli-truncate`.
    return cliTruncatePkg(text, end, { position: 'end', truncationCharacter: overflowIndicator })
  }
  // Fallback for non-zero start with overflow: slice first, then truncate
  // the slice to fit (end - start) cols from the right.
  const sliced = sliceAnsiPkg(text, start, end)
  const totalWidth = stringWidthPkg(text)
  const targetWidth = (end ?? totalWidth) - Math.max(0, start)
  return cliTruncatePkg(sliced, targetWidth, { position: 'end', truncationCharacter: overflowIndicator })
}

/** Strip ANSI escape codes. Replaces `util.stripVTControlCharacters`. */
export function stripAnsi(text: string): string {
  return hasBun() ? Bun.stripANSI(text) : stripAnsiPkg(text)
}