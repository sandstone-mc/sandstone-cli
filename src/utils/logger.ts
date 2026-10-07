import path from 'path'
import { format, stripVTControlCharacters } from 'util'

import * as fs from './fs.js'

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'TRACE' | false

interface FileSinkRecord {
  filePath: string
  writer: Bun.FileSink
  initPromise: Promise<void>
}

interface SinkState {
  liveCallback: ((level: LogLevel, args: unknown[]) => void) | null
  liveBuffer: { level: LogLevel, args: unknown[] }[]
  liveReady: boolean
  silent: boolean
}

type LiveCallback = (level: LogLevel, args: unknown[]) => void

export interface LoggerSink {
  readonly name: string
  log(...args: unknown[]): Promise<void>
  logInfo(...args: unknown[]): Promise<void>
  logWarn(...args: unknown[]): Promise<void>
  logDebug(...args: unknown[]): Promise<void>
  logTrace(...args: unknown[]): Promise<void>
  logError(error: unknown): Promise<void>
  setLiveCallback(callback: LiveCallback): void
  drainBuffer(): void
  setSilent(value: boolean): void
}

export class Logger {
  private readonly fileSinks = new Map<string, FileSinkRecord>()
  private readonly sinkStates = new Map<string, SinkState>()
  private readonly sinkHandles = new Map<string, LoggerSink>()
  private readonly pendingInits = new Map<string, Promise<void>>()
  private readonly pendingWrites: Promise<void>[] = []

  sinks: { readonly [name: string]: LoggerSink } = new Proxy({} as { [k: string]: LoggerSink }, {
    get: (_target, prop) => {
      if (typeof prop !== 'string') return undefined
      let handle = this.sinkHandles.get(prop)
      if (!handle) {
        handle = this.makeSink(prop)
        this.sinkHandles.set(prop, handle)
      }
      return handle
    },
    has: (_target, prop) => typeof prop === 'string',
  })

  private makeSink(name: string): LoggerSink {
    const state: SinkState = {
      liveCallback: null,
      liveBuffer: [],
      liveReady: false,
      silent: false,
    }
    this.sinkStates.set(name, state)
    return {
      name,
      log: (...args) => this.writeTo(name, state, false, ...args),
      logInfo: (...args) => this.writeTo(name, state, 'INFO', ...args),
      logWarn: (...args) => this.writeTo(name, state, 'WARN', ...args),
      logDebug: (...args) => this.writeTo(name, state, 'DEBUG', ...args),
      logTrace: (...args) => this.writeTo(name, state, 'TRACE', ...args),
      logError: (error) => {
        if (typeof error === 'string') return this.writeTo(name, state, 'ERROR', error)
        const err = error as { message?: string; stack?: string }
        const msg = err?.message || String(error)
        const stack = err?.stack ? ['\n', err.stack] : []
        return this.writeTo(name, state, 'ERROR', msg, ...stack)
      },
      setLiveCallback(callback: LiveCallback): void {
        state.liveCallback = callback
        state.liveReady = true
        if (state.liveBuffer.length > 0) {
          for (const entry of state.liveBuffer) callback(entry.level, entry.args)
          state.liveBuffer = []
        }
      },
      drainBuffer(): void {
        if (!state.liveCallback) return
        for (const entry of state.liveBuffer) state.liveCallback(entry.level, entry.args)
        state.liveBuffer = []
      },
      setSilent(value: boolean): void {
        state.silent = value
      },
    }
  }

  registerSink(name: string, filePath?: string, headerText?: string): () => Promise<void> {
    if (!filePath) {
      return async () => {}
    }
    const header = `=== ${headerText ?? `${name} log`} started at ${new Date().toISOString()} ===\n`
    const initPromise = (async () => {
      await fs.ensureDir(path.dirname(filePath))
      await Bun.write(filePath, header)
      const writer = Bun.file(filePath).writer({ highWaterMark: 16 * 1024 })
      this.fileSinks.set(name, { filePath, writer, initPromise: Promise.resolve() })
      this.pendingInits.delete(name)
    })().catch((err) => {
      this.pendingInits.delete(name)
      throw err
    })
    this.pendingInits.set(name, initPromise)
    return async () => {
      try { await initPromise } catch {}
      const sink = this.fileSinks.get(name)
      if (!sink) return
      await Promise.all(this.pendingWrites)
      try { await sink.writer.end() } catch {}
      this.fileSinks.delete(name)
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.pendingWrites)
    for (const [name, sink] of this.fileSinks) {
      try { await sink.writer.end() } catch {}
      this.fileSinks.delete(name)
    }
  }

  private async writeTo(name: string, state: SinkState, level: LogLevel, ...args: unknown[]): Promise<void> {
    if (!state.silent) {
      if (state.liveReady) {
        state.liveCallback?.(level, args)
      } else {
        state.liveBuffer.push({ level, args })
      }
    }

    const pending = this.pendingInits.get(name)
    if (pending) {
      try { await pending } catch {}
    }
    const sink = this.fileSinks.get(name)
    if (!sink) return
    try { await sink.initPromise } catch {}
    const prefix = `[${new Date().toISOString()}]${level !== false ? ` [${level}]` : ''} `
    const indent = ' '.repeat(prefix.length)
    const parts = args.map((a) => formatForWrite(a))
    const body = parts.join(' ').replaceAll('\n', `\n${indent}`)
    const line = prefix + body + '\n'
    const promise = writeChunk(sink.writer, line)
    this.pendingWrites.push(promise)
    promise
      .catch((err) => process.stderr.write(`[logger:${name}] write error: ${err}\n`))
      .finally(() => {
        const idx = this.pendingWrites.indexOf(promise)
        if (idx !== -1) this.pendingWrites.splice(idx, 1)
      })
  }
}

function formatForWrite(arg: unknown): string {
  if (typeof arg === 'string') return stripVTControlCharacters(arg)
  if (Buffer.isBuffer(arg) || arg instanceof Uint8Array) return arg.toString('utf8')
  return stripVTControlCharacters(format('%O', arg))
}

function writeChunk(writer: Bun.FileSink, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const written = writer.write(Buffer.from(line))
      void written
      resolve()
    } catch (err) {
      reject(err)
    }
  })
}

export const logger = new Logger()
