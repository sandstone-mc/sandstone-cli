/**
 * Source map resolution for stack traces.
 *
 * Bun doesn't automatically resolve source maps for bundled dependencies,
 * so we manually parse and resolve them for better error messages.
 */

import { SourceMapConsumer, type RawSourceMap } from 'source-map-js'
import { readFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'

// Cache for loaded source map consumers
const sourceMapCache = new Map<string, SourceMapConsumer | null>()

/**
 * Try to load a source map for a given JS file.
 * Returns null if no source map is found or it's invalid.
 */
async function loadSourceMap(jsFilePath: string): Promise<SourceMapConsumer | null> {
  // Check cache first
  if (sourceMapCache.has(jsFilePath)) {
    return sourceMapCache.get(jsFilePath) ?? null
  }

  try {
    // Read the JS file to find the sourceMappingURL
    const jsContent = await readFile(jsFilePath, 'utf8')

    // Look for sourceMappingURL comment
    const match = jsContent.match(/\/\/[#@]\s*sourceMappingURL=(.+)$/m)
    if (!match) {
      sourceMapCache.set(jsFilePath, null)
      return null
    }

    const sourceMappingURL = match[1].trim()
    let mapPath: string

    if (sourceMappingURL.startsWith('data:')) {
      // Inline source map (base64 encoded)
      const base64Match = sourceMappingURL.match(/base64,(.+)/)
      if (!base64Match) {
        sourceMapCache.set(jsFilePath, null)
        return null
      }
      const mapContent = Buffer.from(base64Match[1], 'base64').toString('utf8')
      const rawMap: RawSourceMap = JSON.parse(mapContent)
      const consumer = new SourceMapConsumer(rawMap)
      sourceMapCache.set(jsFilePath, consumer)
      return consumer
    } else {
      // External source map file
      mapPath = resolve(dirname(jsFilePath), sourceMappingURL)
    }

    const mapContent = await readFile(mapPath, 'utf8')
    const rawMap: RawSourceMap = JSON.parse(mapContent)
    const consumer = new SourceMapConsumer(rawMap)
    sourceMapCache.set(jsFilePath, consumer)
    return consumer
  } catch {
    sourceMapCache.set(jsFilePath, null)
    return null
  }
}

interface StackFrame {
  original: string
  filePath?: string
  line?: number
  column?: number
  functionName?: string
}

/**
 * Parse a single stack trace line.
 */
function parseStackLine(line: string): StackFrame {
  // Match patterns like:
  // "    at functionName (/path/to/file.js:123:45)"
  // "    at /path/to/file.js:123:45"
  // "    at async functionName (/path/to/file.js:123:45)"
  const patterns = [
    // Standard format: at functionName (file:line:col)
    /^\s*at\s+(?:async\s+)?(.+?)\s+\((.+?):(\d+):(\d+)\)$/,
    // Anonymous format: at file:line:col
    /^\s*at\s+(?:async\s+)?(.+?):(\d+):(\d+)$/,
    // Format with <anonymous>: at <anonymous> (file:line:col)
    /^\s*at\s+<anonymous>\s+\((.+?):(\d+):(\d+)\)$/,
  ]

  for (const pattern of patterns) {
    const match = line.match(pattern)
    if (match) {
      if (match.length === 5) {
        // Pattern with function name
        return {
          original: line,
          functionName: match[1],
          filePath: match[2],
          line: parseInt(match[3], 10),
          column: parseInt(match[4], 10),
        }
      } else if (match.length === 4) {
        // Pattern without function name or <anonymous>
        return {
          original: line,
          filePath: match[1],
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
        }
      }
    }
  }

  return { original: line }
}

/**
 * Resolve a stack frame using source maps.
 */
async function resolveStackFrame(frame: StackFrame): Promise<string> {
  if (!frame.filePath || !frame.line || !frame.column) {
    return frame.original
  }

  // Skip native or internal frames
  if (frame.filePath.includes('(native)') || frame.filePath === 'native') {
    return frame.original
  }

  try {
    const consumer = await loadSourceMap(frame.filePath)
    if (!consumer) {
      return frame.original
    }

    const pos = consumer.originalPositionFor({
      line: frame.line,
      column: frame.column - 1, // source-map uses 0-based columns
    })

    if (pos.source && pos.line !== null) {
      // Resolve the source path relative to the JS file
      const sourceDir = dirname(frame.filePath)
      const originalPath = resolve(sourceDir, pos.source)

      // Use source map name if available, then fall back to frame's function name
      // The frame's function name comes from the runtime stack and is often correct
      // even when the source map doesn't have name mappings
      const functionPart = pos.name ?? frame.functionName ?? '<anonymous>'
      const location = `${originalPath}:${pos.line}:${(pos.column ?? 0) + 1}`

      if (functionPart) {
        return `    at ${functionPart} (${location})`
      }
      return `    at ${location}`
    }
  } catch {
    // If resolution fails, return original
  }

  return frame.original
}

/**
 * Resolve source maps in a stack trace string.
 * Returns the stack trace with original source locations where possible.
 */
export async function resolveStackTrace(stack: string): Promise<string> {
  const lines = stack.split('\n')
  const resolvedLines: string[] = []

  for (const line of lines) {
    // Only process lines that look like stack frames
    if (line.trimStart().startsWith('at ')) {
      const frame = parseStackLine(line)
      const resolved = await resolveStackFrame(frame)
      resolvedLines.push(resolved)
    } else {
      resolvedLines.push(line)
    }
  }

  return resolvedLines.join('\n')
}

/**
 * Clear the source map cache.
 * Call this between builds if source maps may have changed.
 */
export function clearSourceMapCache(): void {
  sourceMapCache.clear()
}
