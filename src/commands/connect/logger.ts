import type { LoggerSink } from '../../utils/logger.js'

export interface DaemonLogger {
  debug(message: string, ...extra: unknown[]): void
  info(message: string, ...extra: unknown[]): void
  warn(message: string, ...extra: unknown[]): void
  error(message: string, ...extra: unknown[]): void
}

export const NULL_LOGGER: DaemonLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export const CONSOLE_LOGGER: DaemonLogger = {
  debug: (message, ...extra: unknown[]) => console.log(message, ...extra),
  info: (message, ...extra: unknown[]) => console.log(message, ...extra),
  warn: (message, ...extra: unknown[]) => console.error(message, ...extra),
  error: (message, ...extra: unknown[]) => console.error(message, ...extra),
}

export function createDaemonLogger(sink: LoggerSink): DaemonLogger {
  return {
    debug: (message, ...extra) => { void sink.logDebug(message, ...extra) },
    info: (message, ...extra) => { void sink.logInfo(message, ...extra) },
    warn: (message, ...extra) => { void sink.logWarn(message, ...extra) },
    error: (message, ...extra) => { void sink.logError(message) },
  }
}