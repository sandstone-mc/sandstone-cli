import { randomUUID } from 'node:crypto'
import { WsData } from './server.js'

export interface SubscriptionRecord {
  subscriptionId: string
  ws: Bun.ServerWebSocket<WsData>
  /** Provider's LogSubscription.unattach thunk. Set by `setUnattach`; undefined before then. */
  unattach?: () => Promise<void>
  /**
   * `true` between `registerWithId` and `setUnattach`. Cascade-cleanup
   * during this window marks the record `cancelled` instead of calling
   * the placeholder, so `setUnattach` can fire the real unattach
   * immediately when the host finally resolves.
   */
  pending: boolean
  /** Set by cascade-cleanup that arrived while still `pending`. */
  cancelled: boolean
}

export class SubscriptionRegistry {
  private readonly byId = new Map<string, SubscriptionRecord>()
  /** Reverse lookup for cascade cleanup. */
  private readonly byWs = new WeakMap<object, Set<string>>()

  register(ws: Bun.ServerWebSocket<WsData>): string {
    return this.registerWithId(randomUUID(), ws)
  }

  registerWithId(subscriptionId: string, ws: Bun.ServerWebSocket<WsData>): string {
    if (this.byId.has(subscriptionId)) {
      throw new Error(`subscription id collision: ${subscriptionId}`)
    }
    const record: SubscriptionRecord = {
      subscriptionId,
      ws,
      pending: true,
      cancelled: false,
    }
    this.byId.set(subscriptionId, record)
    const key = ws as object
    let set = this.byWs.get(key)
    if (!set) {
      set = new Set()
      this.byWs.set(key, set)
    }
    set.add(subscriptionId)
    return subscriptionId
  }

  /** Look up a subscription by id. Returns null when unknown. */
  get(subscriptionId: string): SubscriptionRecord | null {
    return this.byId.get(subscriptionId) ?? null
  }

  /**
   * Swap the unattach thunk for a registered subscription. Used by
   * `attachLog` / `attachLogs` which register a placeholder before
   * calling the host (so the handler closure can reference the id) and
   * then replace it with the real provider unattach once it resolves.
   *
   * If cascade-cleanup arrived during the placeholder window (the
   * record was marked `cancelled`), the new unattach is fired
   * immediately and the record dropped — the host's log handler isn't
   * orphaned. No-op if the id isn't registered.
   */
  setUnattach(subscriptionId: string, unattach: () => Promise<void>): void {
    const record = this.byId.get(subscriptionId)
    if (!record) return
    record.unattach = unattach
    record.pending = false
    if (record.cancelled) {
      this.dropAndUnattach(record, unattach)
    }
  }

  /**
   * Unattach + drop a single subscription. Safe to call for unknown ids
   * (returns false rather than throwing). The provider's `unattach` is
   * awaited; errors are swallowed to keep the cleanup path robust.
   *
   * If the subscription is still `pending` (placeholder not yet
   * replaced), marks it `cancelled` instead of calling the placeholder
   * and deleting — `setUnattach` will clean up when the host
   * resolves.
   */
  async unattach(subscriptionId: string): Promise<boolean> {
    const record = this.byId.get(subscriptionId)
    if (!record) return false
    if (record.pending) {
      record.cancelled = true
      return true
    }
    if (!record.unattach) {
      // Non-pending but no unattach installed — should never happen
      // because `setUnattach` is the only path that clears
      // `pending`. Drop the record defensively.
      this.dropAndUnattach(record, async () => {})
      return true
    }
    this.dropAndUnattach(record, record.unattach)
    return true
  }

  /**
   * Cascade-unattach every subscription owned by `ws`. Called from the
   * server's ws.close hook so a dropped client can't leak log handlers.
   *
   * Pending subscriptions are marked `cancelled` rather than dropped —
   * `setUnattach` will fire the real unattach when the host
   * finally resolves, so the host's log handler isn't orphaned.
   */
  async dropAllForWs(ws: Bun.ServerWebSocket<WsData>): Promise<void> {
    const key = ws as object
    const set = this.byWs.get(key)
    if (!set) return
    const ids = Array.from(set)
    this.byWs.delete(key)
    for (const id of ids) {
      const record = this.byId.get(id)
      if (!record) continue
      if (record.pending) {
        record.cancelled = true
        continue
      }
      this.byId.delete(id)
      if (!record.unattach) continue
      try {
        await record.unattach()
      } catch {
        // provider is already gone; nothing to do
      }
    }
  }

  private dropAndUnattach(record: SubscriptionRecord, unattach: () => Promise<void>): void {
    this.byId.delete(record.subscriptionId)
    const set = this.byWs.get(record.ws as object)
    set?.delete(record.subscriptionId)
    unattach().catch(() => {})
  }

  /** Test helper: how many live subscriptions? */
  size(): number {
    return this.byId.size
  }
}