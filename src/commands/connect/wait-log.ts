import type { HostLogHandler, HostLogLine, LogSubscription } from '../../hosts/types.js'

export type LogPattern = {
  kind: 'endsWith' | 'includes' | 'glob' | 'regex',
  value: string,
  timeoutMs?: number,
  /**
   * Optional closer matcher. When set, every line received after the
   * pattern's first match (inclusive) is appended to the result list.
   */
  closingLine?: Omit<LogPattern, 'closingLine'>,
}

export class TimeoutError extends Error {
  constructor(public readonly patternIndex: number, public readonly pattern: LogPattern | undefined, timeoutMs: number) {
    super(
      pattern
        ? `Pattern ${patternIndex} (${JSON.stringify(pattern)}) did not match within ${timeoutMs}ms`
        : `Pattern ${patternIndex} did not match within ${timeoutMs}ms`,
    )
    this.name = 'TimeoutError'
  }
}

export class InterruptedError extends Error {
  constructor() {
    super('LogMatcher interrupted')
    this.name = 'InterruptedError'
  }
}

export type WaitForLogSettlement = (
  {
    patternUUID: string,
    patternIndex: number,
    status: 'matched',
    lines: string[],
  } | {
    patternUUID: string,
    patternIndex: number,
    status: 'timed_out',
    timeoutMs: number,
  }
)

export type WaitForLogEntry = WaitForLogSettlement | {
  patternUUID: string,
  patternIndex: number,
  status: 'interrupted',
}

type CompiledMatcher = (
  | { kind: 'endsWith', value: string }
  | { kind: 'includes', value: string }
  | { kind: 'glob', glob: Bun.Glob }
  | { kind: 'regex', regex: RegExp }
)

type MatcherState = {
  index: number,
  opening: LogPattern,
  uuid: string,
  group: string,
  promise: Promise<string[]>,
  resolveLines: (lines: string[]) => void,
  rejectPending: (err: Error) => void,
  settled: boolean,
  listeners: Set<(entry: WaitForLogEntry) => void>,
  buffer: string[],
  openingTimer: ReturnType<typeof setTimeout> | null,
  closingTimer: ReturnType<typeof setTimeout> | null,
  compiledOpening: CompiledMatcher,
  compiledClosing: CompiledMatcher | null,
}

export class LogMatcher {
  private readonly matchers = new Map<string, MatcherState>()
  private subscription: LogSubscription | null = null
  private subscriptionPromise: Promise<void> | null = null

  constructor(private readonly attachLog: (handler: HostLogHandler) => Promise<LogSubscription>) {}

  async waitForLog(patterns: LogPattern[]) {
    const group = crypto.randomUUID()
    const states = patterns.map((opening, index) => this.createMatcher(opening, group, index))
    await this.ensureSubscribed()

    const matcher = this
    return {
      promises: states.map((s) => s.promise),
      patternUUIDs: states.map((s) => s.uuid),
      subscribe(fn: (entry: WaitForLogEntry) => void) {
        for (const state of states) state.listeners.add(fn)
      },
      async interrupt() {
        await matcher.removeByGroup(group)
      },
    }
  }

  size() {
    return this.matchers.size
  }

  private createMatcher(opening: LogPattern, group: string, index: number) {
    const id = crypto.randomUUID()
    if (this.matchers.has(id)) {
      throw new Error(`LogMatcher: matcher id collision: ${id}`)
    }
    const uuid = crypto.randomUUID()

    const state: MatcherState = {
      index,
      opening,
      uuid,
      group,
      promise: undefined!,
      resolveLines: () => {},
      rejectPending: () => {},
      settled: false,
      listeners: new Set(),
      buffer: [],
      openingTimer: null,
      closingTimer: null,
      compiledOpening: LogMatcher.compile(opening),
      compiledClosing: opening.closingLine ? LogMatcher.compile(opening.closingLine) : null,
    }
    state.promise = new Promise<string[]>((res, rej) => {
      state.resolveLines = res
      state.rejectPending = rej
    })

    // Start the opening timer (if any) immediately — it bounds how
    // long we wait for the opening line.
    state.openingTimer = this.startOpeningTimer(state, opening)

    this.matchers.set(id, state)
    return state
  }

  private removeByGroup(group: string) {
    for (const [id, state] of [...this.matchers]) {
      if (state.group !== group) continue
      this.matchers.delete(id)
      this.interruptState(state)
      break
    }
    return this.maybeCloseSubscription()
  }

  private fire(state: MatcherState, entry: WaitForLogEntry) {
    for (const fn of state.listeners) fn(entry)
  }

  private interruptState(state: MatcherState) {
    if (state.settled) return
    state.settled = true
    if (state.openingTimer) clearTimeout(state.openingTimer)
    if (state.closingTimer) clearTimeout(state.closingTimer)
    this.fire(state, { patternUUID: state.uuid, patternIndex: state.index, status: 'interrupted' })
    state.rejectPending(new InterruptedError())
  }

  private settleMatched(state: MatcherState, lines: string[]) {
    if (state.settled) return
    state.settled = true
    if (state.openingTimer) clearTimeout(state.openingTimer)
    if (state.closingTimer) clearTimeout(state.closingTimer)
    this.fire(state, { patternUUID: state.uuid, patternIndex: state.index, status: 'matched', lines })
    state.resolveLines(lines)
  }

  private settleTimedOut(state: MatcherState, pattern: LogPattern, timeoutMs: number) {
    if (state.settled) return
    state.settled = true
    if (state.openingTimer) clearTimeout(state.openingTimer)
    if (state.closingTimer) clearTimeout(state.closingTimer)
    this.fire(state, { patternUUID: state.uuid, patternIndex: state.index, status: 'timed_out', timeoutMs })
    state.rejectPending(new TimeoutError(-1, pattern, timeoutMs))
    void this.maybeCloseSubscription()
  }

  private async ensureSubscribed() {
    if (this.subscription) return
    if (this.subscriptionPromise) return this.subscriptionPromise
    this.subscriptionPromise = (async () => {
      try {
        this.subscription = await this.attachLog((lines) => this.handleLines(lines))
      } finally {
        this.subscriptionPromise = null
      }
    })()
    return this.subscriptionPromise
  }

  private async maybeCloseSubscription() {
    if (this.matchers.size === 0 && this.subscription) {
      await this.closeSubscription()
    }
  }

  private async closeSubscription() {
    if (!this.subscription) return
    const sub = this.subscription
    this.subscription = null
    await sub.unattach().catch(() => {})
  }

  private handleLines(chunks: HostLogLine[]) {
    for (const chunk of chunks) {
      const line = chunk.line
      for (const state of this.matchers.values()) {
        if (state.settled) {
          console.error('[LogMatcher#handleLines] This should never happen!')
          continue
        }
        const compiledClosing = state.compiledClosing

        if (state.buffer.length > 0) {
          state.buffer.push(line)
          if (compiledClosing && LogMatcher.matchesCompiled(compiledClosing, line)) {
            this.settleMatched(state, state.buffer)
            continue
          }
          continue
        }

        if (!LogMatcher.matchesCompiled(state.compiledOpening, line)) continue
        if (state.openingTimer) clearTimeout(state.openingTimer)

        if (compiledClosing) {
          state.buffer = [line]
          if (LogMatcher.matchesCompiled(compiledClosing, line)) {
            this.settleMatched(state, state.buffer)
            continue
          }
          state.closingTimer = this.startClosingTimer(state, state.opening.closingLine!)
        } else {
          this.settleMatched(state, [line])
        }
      }
    }
  }

  private startOpeningTimer(state: MatcherState, opening: LogPattern): ReturnType<typeof setTimeout> | null {
    if (opening.timeoutMs === undefined) return null
    return setTimeout(() => {
      if (state.settled) return
      this.settleTimedOut(state, opening, opening.timeoutMs!)
    }, opening.timeoutMs)
  }

  private startClosingTimer(state: MatcherState, closing: LogPattern): ReturnType<typeof setTimeout> | null {
    if (closing.timeoutMs === undefined) return null
    return setTimeout(() => {
      if (state.settled) return
      this.settleTimedOut(state, closing, closing.timeoutMs!)
    }, closing.timeoutMs)
  }

  private static compile(pattern: LogPattern): CompiledMatcher {
    switch (pattern.kind) {
      case 'endsWith': return { kind: 'endsWith', value: pattern.value }
      case 'includes': return { kind: 'includes', value: pattern.value }
      case 'glob':     return { kind: 'glob', glob: new Bun.Glob(pattern.value) } // TODO: Don't we have a better globbing library than this?
      case 'regex':    return { kind: 'regex', regex: new RegExp(pattern.value) }
    }
  }

  private static matchesCompiled(c: CompiledMatcher, line: string) {
    switch (c.kind) {
      case 'endsWith': return line.endsWith(c.value)
      case 'includes': return line.includes(c.value)
      case 'glob':     return c.glob.match(line)
      case 'regex':    return c.regex.test(line)
    }
  }
}