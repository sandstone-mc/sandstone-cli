/**
 * Internal types for the `sand connect` daemon.
 *
 * Not part of the wire protocol (see `./rpc.ts` for that) — these describe
 * the per-connection state the server tracks while a client is connected.
 */

import type { HostProvider, LogSubscription } from '../../hosts/types.js'

/**
 * Per-WebSocket connection state. The server creates one when a client
 * dials and disposes it on close. `host` is shared across connections
 * (single provider per daemon); `subscriptions` are not.
 */
export interface SessionContext {
  host: HostProvider
  /** Owns subscriptions for THIS ws; cleared on disconnect. */
  subscriptions: Set<string>
  /** Per-subscription log line coalescer state. The wire `log` event
   *  carries the subscriptionId so the client can route the batch to the
   *  right `onLines` callback — multiple subscriptions in one session
   *  (e.g. attachLog + attachLogs) must stay separated, even within the
   *  same coalescer window. */
  pendingBySub: Map<string, string[]>
  flushTimerBySub: Map<string, ReturnType<typeof setTimeout>>
  /** True after `daemonShutdown` was sent — stops accepting requests. */
  shuttingDown: boolean
}

/**
 * Internal record the registry keeps for each live `attachLog` subscription.
 * `unattach` is the provider's `LogSubscription.unattach` thunk so callers
 * can stop receiving lines without holding the registry directly.
 */
export interface SubscriptionRecord {
  subscriptionId: string
  ws: unknown
  unattach: LogSubscription['unattach']
}