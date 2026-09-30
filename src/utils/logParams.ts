/**
 * Shared log-filter helpers.
 *
 * The MCP `sandstone://*-log` resources translate URI-template sentinels
 * (`-1` = "no filter") into the daemon's RPC wire shape (`null` /
 * `undefined`). The daemon's own read-log handlers and the MCP resource
 * layer share these helpers so the same sentinel convention lives in
 * exactly one place.
 *
 * Line-range and tail filtering is also shared — both the MCP
 * `readClientLog` resource (filtering lines returned by
 * `daemon.readClientLog`) and any future MCP-side filter passes
 * route through {@link applyLogRange}.
 */

import type { ReadClientLogParams, ReadBuildLogParams } from '../commands/connect/rpc.js'

/**
 * Translate MCP URI template sentinels to the daemon's wire shape for
 * the read-log RPC family. `-1` → `null` for numeric filters;
 * `from`/`to` are folded into a `range` object only when both are
 * non-sentinel.
 */
export function coerceFileLogParams(params: {
  tail: number
  maxLines: number
  from: number
  to: number
  since: number
  until: number
}): Pick<ReadBuildLogParams, 'tail' | 'maxLines' | 'range' | 'since' | 'until'> {
  return {
    tail: params.tail === -1 ? null : params.tail,
    maxLines: params.maxLines === -1 ? null : params.maxLines,
    range: params.from !== -1 && params.to !== -1 ? { from: params.from, to: params.to } : null,
    since: params.since === -1 ? null : params.since,
    until: params.until === -1 ? null : params.until,
  }
}

/** Three-param version for the `readClientLog` resource (no time bounds). */
export function coerceClientLogParams(params: {
  tail: number
  from: number
  to: number
}): Pick<ReadClientLogParams, 'tail' | 'maxLines' | 'range'> {
  return {
    tail: params.tail === -1 ? null : params.tail,
    maxLines: null,
    range: params.from !== -1 && params.to !== -1 ? { from: params.from, to: params.to } : null,
  }
}

/**
 * Apply tail / line-ID range to a line array. `0` is the most recent
 * (last) line; line IDs are non-negative. `-1` sentinel means
 * "don't apply this filter". Returns the post-filter slice (still in
 * original order — newest at the end).
 */
export function applyLogRange(
  lines: string[],
  params: { tail: number; from: number; to: number },
): string[] {
  const len = lines.length
  if (params.from !== -1 && params.to !== -1) {
    const startIdx = len - 1 - Math.min(params.from, len - 1)
    const endIdx = len - 1 - Math.min(params.to, len - 1)
    const lo = Math.max(0, Math.min(startIdx, endIdx))
    const hi = Math.min(len - 1, Math.max(startIdx, endIdx))
    return lines.slice(lo, hi + 1)
  }
  const want = params.tail === -1 ? 200 : params.tail
  return lines.slice(-want)
}

/**
 * Format the standard MCP log-resource header. `label` is the
 * human-readable log name ("Watcher log", "Server log", etc.); `extra`
 * are additional optional lines (e.g. "no test runner has pushed
 * lines yet"). Returns the lines joined with `\n`, omitting empty /
 * null entries.
 */
export function formatLogHeader(
  label: string,
  result: {
    lines: string[]
    matchedLines: number
    totalLines: number
    truncated: boolean
    oldestTs?: string | null
    newestTs?: string | null
  },
  extra: ReadonlyArray<string | null | undefined> = [],
): string {
  const lines = [
    `# ${label} (${result.lines.length} of ${result.matchedLines} matched; ${result.totalLines} buffered)`,
    result.oldestTs ? `oldest: ${result.oldestTs}` : null,
    result.newestTs ? `newest: ${result.newestTs}` : null,
    result.truncated ? 'TRUNCATED — increase tail/maxLines or narrow range/since' : null,
    ...extra,
  ]
  return lines.filter((l): l is string => !!l).join('\n')
}