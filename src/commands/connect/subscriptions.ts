import { randomUUID } from 'node:crypto'
import type { WsData } from './daemon.js'

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
  private readonly byWs = new Map<string, Set<string>>()

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
    let set = this.byWs.get(ws.data.secret)
    if (!set) {
      set = new Set()
      this.byWs.set(ws.data.secret, set)
    }
    set.add(subscriptionId)
    return subscriptionId
  }

  get(subscriptionId: string): SubscriptionRecord | null {
    return this.byId.get(subscriptionId) ?? null
  }

  setUnattach(subscriptionId: string, unattach: () => Promise<void>): void {
    const record = this.byId.get(subscriptionId)
    if (!record) return
    record.unattach = unattach
    record.pending = false
    if (record.cancelled) {
      this.dropAndUnattach(record, unattach)
    }
  }

  async unattach(subscriptionId: string): Promise<boolean> {
    const record = this.byId.get(subscriptionId)
    if (!record) return false
    if (record.pending) {
      record.cancelled = true
      return true
    }
    if (!record.unattach) {
      // TODO: Add a log here that warns when this happens, we shouldn't reach this
      this.dropAndUnattach(record, async () => {})
      return true
    }
    this.dropAndUnattach(record, record.unattach)
    return true
  }

  async dropAllForWs(ws: Bun.ServerWebSocket<WsData>): Promise<void> {
    const set = this.byWs.get(ws.data.secret)
    if (!set) return
    const ids = Array.from(set)
    this.byWs.delete(ws.data.secret)
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
      } catch {}
    }
  }

  private dropAndUnattach(record: SubscriptionRecord, unattach: () => Promise<void>): void {
    this.byId.delete(record.subscriptionId)
    const set = this.byWs.get(record.ws.data.secret)
    set?.delete(record.subscriptionId)
    unattach().catch(() => {})
  }

  size(): number {
    return this.byId.size
  }
}

export class WaitLogSubscriptionRegistry {
  private nextId = 1
  private readonly byId = new Map<string, { socketKey: string, handle: { interrupt(): Promise<void> } }>()
  private readonly byWs = new Map<string, Set<string>>()

  generateId(): string {
    let id: string
    do {
      id = `waitlog-${this.nextId++}`
    } while (this.byId.has(id))
    return id
  }

  register(subscriptionId: string, socketKey: string, handle: { interrupt(): Promise<void> }): void {
    this.byId.set(subscriptionId, { socketKey, handle })
    let set = this.byWs.get(socketKey)
    if (!set) {
      set = new Set()
      this.byWs.set(socketKey, set)
    }
    set.add(subscriptionId)
  }

  drop(subscriptionId: string): { interrupt(): Promise<void> } | null {
    const entry = this.byId.get(subscriptionId)
    if (!entry) return null
    this.byId.delete(subscriptionId)
    this.byWs.get(entry.socketKey)?.delete(subscriptionId)
    return entry.handle
  }

  async dropAllForWs(socketKey: string): Promise<void> {
    const set = this.byWs.get(socketKey)
    if (!set) return
    const ids = Array.from(set)
    this.byWs.delete(socketKey)
    for (const id of ids) {
      const entry = this.byId.get(id)
      if (!entry) continue
      this.byId.delete(id)
      try {
        await entry.handle.interrupt()
      } catch {}
    }
  }

  size(): number {
    return this.byId.size
  }
}