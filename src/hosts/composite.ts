import { UnsupportedCapabilityError } from './errors.js'
import type {
  CapabilityMethods,
  HostCapabilities,
  HostProvider,
  HostType,
  LogChunkFanoutHandler,
  LogChunkHandler,
  LogSubscription,
  ServerPath,
} from './types.js'
import { mergeCapabilities } from './types.js'

/**
 * Multi-provider dispatcher. Each capability is independently dispatched to
 * the first member in the list that both declares it (via `capabilities`)
 * and implements the corresponding method. Capabilities with zero matching
 * implementors throw `UnsupportedCapabilityError`.
 *
 * Composite is NOT registered in the provider map — it's constructed by
 * callers from a list. `CompositeHost.type` is a synthetic tag (not in
 * `HostType`); the type field exists only because `HostProvider` requires
 * it for ergonomic compatibility.
 *
 * For the multi-log case (e.g. integrated server + local-client log), use
 * `attachLogs` instead of `attachLog` — it fans out to every attachLog-
 * capable member and tags chunks with the emitting provider's type.
 */
export class CompositeHost implements HostProvider {
  // 'composite' is a synthetic tag — callers that read it should treat
  // CompositeHost specially. The `HostProvider.type` contract is HostType,
  // but we widen the field to `string` to allow this tag without
  // polluting `HostType` with a non-provider literal.
  readonly type: HostType = 'composite' as unknown as HostType
  readonly displayName: string
  readonly capabilities: HostCapabilities
  readonly members: readonly HostProvider[]

  constructor(members: HostProvider[], displayName = 'Composite Host') {
    if (members.length === 0) {
      throw new Error('CompositeHost requires at least one member')
    }
    this.members = [...members]
    this.displayName = displayName
    this.capabilities = mergeCapabilities(members.map((m) => m.capabilities))
  }

  async connect(): Promise<void> {
    const connected: HostProvider[] = []
    try {
      for (const m of this.members) {
        await m.connect()
        connected.push(m)
      }
    } catch (err) {
      // Roll back already-connected members in reverse order so a partial
      // failure doesn't leak connections.
      for (const m of connected.reverse()) {
        await m.disconnect().catch(() => {})
      }
      throw err
    }
  }

  async disconnect(): Promise<void> {
    const errors: unknown[] = []
    for (const m of this.members) {
      try {
        await m.disconnect()
      } catch (e) {
        errors.push(e)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'CompositeHost disconnect failures')
    }
  }

  isConnected(): boolean {
    return this.members.every((m) => m.isConnected())
  }

  // Capability dispatchers — pick first member whose capabilities flag is
  // true AND whose method is defined. UnsupportedCapabilityError otherwise.

  async startServer(): Promise<void> {
    return this.dispatch('startServer')
  }

  async stopServer(): Promise<void> {
    return this.dispatch('stopServer')
  }

  async readFile(path: ServerPath): Promise<Buffer> {
    return this.dispatch('readFile', path)
  }

  async writeFile(path: ServerPath, data: Buffer | string): Promise<void> {
    return this.dispatch('writeFile', path, data)
  }

  async attachLog(onChunk: LogChunkHandler): Promise<LogSubscription> {
    return this.dispatch('attachLog', onChunk)
  }

  async executeRawCommand(command: string): Promise<string> {
    return this.dispatch('executeRawCommand', command)
  }

  /**
   * Fan-out: subscribe to every member with attachLog. Each call invokes
   * `onChunk` with the emitting provider's `type` so the caller can label
   * output (e.g. `[server]` vs `[client]`). Returns a single subscription
   * whose `unattach()` releases all underlying streams. Used when callers
   * need to observe both a managed server log (integrated) and a client log
   * (local-client) simultaneously — the singular `attachLog` only routes to
   * the first capable member.
   */
  async attachLogs(onChunk: LogChunkFanoutHandler): Promise<LogSubscription> {
    const subs: LogSubscription[] = []
    const settled: LogSubscription[] = []
    try {
      for (const m of this.members) {
        if (!m.capabilities.attachLog) continue
        if (typeof m.attachLog !== 'function') continue
        const sub = await m.attachLog((lines) => onChunk(m.type as HostType, lines))
        settled.push(sub)
        subs.push(sub)
      }
      return {
        async unattach() {
          await Promise.allSettled(subs.map((s) => s.unattach()))
        },
      }
    } catch (err) {
      // Roll back any already-attached subscriptions so a partial failure
      // doesn't leave the caller holding leaked streams.
      await Promise.allSettled(settled.map((s) => s.unattach().catch(() => {})))
      throw err
    }
  }

  private async dispatch<K extends keyof CapabilityMethods>(
    capability: K,
    ...args: Parameters<CapabilityMethods[K]>
  ): Promise<ReturnType<CapabilityMethods[K]>> {
    for (const m of this.members) {
      if (!m.capabilities[capability]) continue
      const fn = (m as unknown as Record<string, unknown>)[capability]
      if (typeof fn !== 'function') continue
      const result = await (fn as (...a: unknown[]) => unknown).apply(m, args)
      return result as ReturnType<CapabilityMethods[K]>
    }
    throw new UnsupportedCapabilityError(capability)
  }
}