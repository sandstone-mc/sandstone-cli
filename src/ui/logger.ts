import path from 'path'
import { stripVTControlCharacters, format } from 'util'
import * as fs from '../utils/fs.js'

let logPath: string | null = null
let liveLogCallback: ((level: string | false, args: unknown[]) => void) | null = null
let liveLogBuffer: { level: string | false; args: unknown[] }[] = []
let liveLogReady = false
let silent = false

// Track initialization and pending writes
let initPromise: Promise<void> | null = null
let writer: Bun.FileSink | null = null
const pendingWrites: Promise<void>[] = []

export function initLogger(rootFolder: string): () => Promise<void> {
  logPath = path.join(rootFolder, '.sandstone', 'watch.log')

  // Start logWorkerInit detached
  initPromise = logWorkerInit()

  // Return async function that awaits logWorkerFinish
  return () => logWorkerFinish()
}

/**
 * Initialize the logger without file writing.
 * Use this for `sand build` where we want logging but no persistent log file.
 */
export function initLoggerNoFile() {
  logPath = null
  liveLogReady = true
  // Set a default callback that prints to console
  liveLogCallback = (level, args) => {
    console.log(...(level ? [`[${level}]`] : []), ...args)
  }
}

/**
 * Set whether the logger should suppress live output.
 */
export function setSilent(value: boolean) {
  silent = value
}

export function setLiveLogCallback(callback: typeof liveLogCallback) {
  liveLogCallback = callback
}

export function drainLiveLogBuffer() {
  liveLogReady = true
  if (liveLogCallback && liveLogBuffer.length > 0) {
    for (const { level, args } of liveLogBuffer) {
      liveLogCallback(level, args)
    }
    liveLogBuffer = []
  }
}

async function logWorkerInit() {
  await fs.ensureDir(path.dirname(logPath!))
  // Write the header line, then open an append-mode FileSink for incremental
  // writes. The FileSink buffers internally and auto-flushes at the high
  // water mark, so the per-line cost is just a buffer append.
  const header = `=== Watch started at ${new Date().toISOString()} ===\n`
  await Bun.write(logPath!, header)
  writer = Bun.file(logPath!).writer({ highWaterMark: 16 * 1024 })
}

async function logWorkerMain(level: string | false, ...args: unknown[]) {
  // Await logWorkerInit finishing if it isn't finished
  if (initPromise) {
    await initPromise
  }

  // Skip empty log calls
  if (args.length === 0) {
    return
  }

  // Skip logs that are just empty strings
  if (args.length === 1 && typeof args[0] === 'string' && stripVTControlCharacters(args[0]).trim() === '') {
    return
  }

  // Collect all chunks first
  const chunks: (string | Buffer | Uint8Array)[] = []

  // Timestamp and level prefix
  const prefix = `[${new Date().toISOString()}]${level !== false ? ` [${level}]` : ''} `
  chunks.push(prefix)

  // Process each argument
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (typeof arg === 'string') {
      chunks.push(stripVTControlCharacters(arg).replaceAll('\n', `\n${' '.repeat(prefix.length)}`))
    } else if (Buffer.isBuffer(arg) || arg instanceof Uint8Array) {
      chunks.push(arg)
    } else if (arg instanceof ArrayBuffer) {
      chunks.push(new Uint8Array(arg))
    } else if (arg instanceof Blob) {
      chunks.push(new Uint8Array(await arg.arrayBuffer()))
    } else {
      // Use util.format for objects, numbers, etc.
      chunks.push(stripVTControlCharacters(format('%O', arg)).replaceAll('\n', `\n${' '.repeat(prefix.length)}`))
    }
    // Add space between args (but not after last)
    if (i < args.length - 1) {
      chunks.push(' ')
    }
  }

  chunks.push('\n')

  // Concatenate all chunks into a single buffer for atomic write
  const buffers = chunks.map(chunk =>
    typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
  )
  await writeChunk(Buffer.concat(buffers))
}

function writeChunk(chunk: string | Buffer | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!writer) {
      reject(new Error('Writer not initialized'))
      return
    }
    // FileSink.write takes a typed ArrayBufferView / string. Coerce string
    // to Buffer (the underlying sink handles either); unwrap Uint8Array to
    // its underlying buffer for the same reason.
    try {
      const data = typeof chunk === 'string'
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? chunk
          : chunk
      const written = writer.write(data as any)
      void written
      resolve()
    } catch (err) {
      reject(err)
    }
  })
}

async function logWorkerFinish() {
  // Make sure to await logWorkerInit being finished
  if (initPromise) {
    await initPromise
  }

  // Make sure to await all pending logWorkerMain calls
  await Promise.all(pendingWrites)

  // Close the writer. `end()` flushes the buffer before closing the FD.
  if (writer) {
    await writer.end()
    writer = null
  }
}

function writeLog(level: string | false, ...args: unknown[]) {
  if (!silent) {
    if (liveLogReady) {
      liveLogCallback?.(level, args)
    } else {
      liveLogBuffer.push({ level, args })
    }
  }

  if (logPath) {
    // Call logWorkerMain detached and track the promise
    const writePromise = logWorkerMain(level, ...args)
    pendingWrites.push(writePromise)
    // Clean up completed promises to avoid memory leak
    writePromise
      .catch((err) => {
        // Log to stderr so we can see file write errors
        process.stderr.write(`[logger] Write error: ${err}\n`)
      })
      .finally(() => {
        const idx = pendingWrites.indexOf(writePromise)
        if (idx !== -1) pendingWrites.splice(idx, 1)
      })
  }
}

export function log(...args: unknown[]) {
  writeLog(false, ...args)
}

export function logInfo(...args: unknown[]) {
  writeLog('INFO', ...args)
}

export function logWarn(...args: unknown[]) {
  writeLog('WARN', ...args)
}

export function logDebug(...args: unknown[]) {
  writeLog('DEBUG', ...args)
}

export function logTrace(...args: unknown[]) {
  writeLog('TRACE', ...args)
}

export function logError(error: unknown) {
  if (typeof error === 'string') {
    writeLog('ERROR', error)
  } else {
    const err = error as { message?: string; stack?: string }
    writeLog('ERROR', err?.message || String(error), ...(err?.stack ? ['\n', err.stack] : []))
  }
}
