import chalk from 'chalk-template'
import type { BenchEvent, BenchEventSink } from './types.js'

export function emitStatus(
  message: string,
  onEvent: BenchEventSink,
  type?: string,
  fields?: { run?: number, runs?: number },
): void {
  onEvent({
    event: 'status',
    message,
    ...(type !== undefined ? { type } : {}),
    ...(fields ?? {}),
  })
}

export function emitError(message: string, onEvent: BenchEventSink): void {
  onEvent({ event: 'error', message })
}

export function renderBenchEvent(event: BenchEvent): string[] {
  switch (event.event) {
    case 'status': {
      return [chalk`{cyan [bench]} ${event.message}`]
    }
    case 'error': {
      return [chalk`{red Error:} ${event.message}`]
    }
    case 'result': {
      return []
    }
  }
}
