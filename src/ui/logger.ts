import fs from 'fs-extra'
import path from 'path'
import { stripVTControlCharacters, format } from 'util'

let logPath: string
let liveLogCallback: ((level: string | false, args: unknown[]) => void) | null = null
let liveLogBuffer: { level: string | false; args: unknown[] }[] = []
let liveLogReady = false

// Track initialization and pending writes
let initPromise: Promise<void> | null = null
let writer: fs.WriteStream | null = null
const pendingWrites: Promise<void>[] = []

export function initLogger(rootFolder: string): () => Promise<void> {
  logPath = path.join(rootFolder, '.sandstone', 'watch.log')

  // Start logWorkerInit detached
  initPromise = logWorkerInit()

  // Return async function that awaits logWorkerFinish
  return () => logWorkerFinish()
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
  await fs.ensureDir(path.dirname(logPath))
  await fs.writeFile(logPath, `=== Watch started at ${new Date().toISOString()} ===\n`)
  writer = fs.createWriteStream(logPath, { flags: 'a' })
  // Wait for the stream to be ready before allowing writes
  await new Promise<void>((resolve, reject) => {
    writer!.once('open', () => resolve())
    writer!.once('error', reject)
  })
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
  chunks.push(`[${new Date().toISOString()}]${level !== false ? ` [${level}]` : ''} `)

  // Process each argument
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (typeof arg === 'string') {
      chunks.push(stripVTControlCharacters(arg))
    } else if (Buffer.isBuffer(arg) || arg instanceof Uint8Array) {
      chunks.push(arg)
    } else if (arg instanceof ArrayBuffer) {
      chunks.push(new Uint8Array(arg))
    } else if (arg instanceof Blob) {
      chunks.push(new Uint8Array(await arg.arrayBuffer()))
    } else {
      // Use util.format for objects, numbers, etc.
      chunks.push(format('%O', arg))
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
    writer.write(chunk, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function logWorkerFinish() {
  // Make sure to await logWorkerInit being finished
  if (initPromise) {
    await initPromise
  }

  // Make sure to await all pending logWorkerMain calls
  await Promise.all(pendingWrites)

  // Close the writer
  if (writer) {
    await new Promise<void>((resolve, reject) => {
      writer!.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    writer = null
  }
}

function writeLog(level: string | false, ...args: unknown[]) {
  if (liveLogReady) {
    liveLogCallback?.(level, args)
  } else {
    liveLogBuffer.push({ level, args })
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
