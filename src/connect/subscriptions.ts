/**
 * Per-WebSocket subscription registry.
 *
 * Tracks live `attachLog` subscriptions so we can:
 *  - Resolve `subscriptionId` → owning ws + unattach thunk
 *  - Cascade-unattach everything on ws close (no leaked log handlers
 *    if the consumer disconnects without sending `unattach`)
 *
 * Server-side only — consumers shouldn't need to know about this.
 */

import { randomUUID } from 'node:crypto'

export interface SubscriptionRecord {
  subscriptionId: string
  /** Opaque WebSocket handle (Bun's `ServerWebSocket`). Typed as `unknown` so this module stays host-agnostic. */
  ws: unknown
  /** Provider's LogSubscription.unattach thunk. */
  unattach: () => Promise<void>
}

export class SubscriptionRegistry {
  private readonly byId = new Map<string, SubscriptionRecord>()
  /** Reverse lookup for cascade cleanup. */
  private readonly byWs = new WeakMap<object, Set<string>>()

  /**
   * Register a subscription. Returns the assigned id (which the caller
   * will hand to the consumer in the `attachLog` response).
   */
  register(ws: unknown, unattach: () => Promise<void>): string {
    const subscriptionId = randomUUID()
    const record: SubscriptionRecord = { subscriptionId, ws, unattach }
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
   * Unattach + drop a single subscription. Safe to call for unknown ids
   * (returns false rather than throwing). The provider's `unattach` is
   * awaited; errors are swallowed to keep the cleanup path robust.
   */
  async unattach(subscriptionId: string): Promise<boolean> {
    const record = this.byId.get(subscriptionId)
    if (!record) return false
    this.byId.delete(subscriptionId)
    const set = this.byWs.get(record.ws as object)
    set?.delete(subscriptionId)
    try {
      await record.unattach()
    } catch {
      // provider is already gone; nothing to do
    }
    return true
  }

  /**
   * Cascade-unattach every subscription owned by `ws`. Called from the
   * server's ws.close hook so a dropped client can't leak log handlers.
   */
  async dropAllForWs(ws: unknown): Promise<void> {
    const key = ws as object
    const set = this.byWs.get(key)
    if (!set) return
    const ids = Array.from(set)
    this.byWs.delete(key)
    for (const id of ids) {
      const record = this.byId.get(id)
      this.byId.delete(id)
      if (!record) continue
      try {
        await record.unattach()
      } catch {
        // ignore
      }
    }
  }

  /** Test helper: how many live subscriptions? */
  size(): number {
    return this.byId.size
  }
}