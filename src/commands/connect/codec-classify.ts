/**
 * WS message envelope classifier.
 *
 * Both the daemon's server side (src/commands/connect/server.ts) and
 * the client's message handler (src/commands/connect/client.ts)
 * decode the same wire envelopes. Until now the parser logic was
 * duplicated — server.ts used the shared `tryParseRequest` /
 * `tryParseEvent` / `tryParseMethodNotification` helpers from
 * rpc.ts, while client.ts re-implemented inline. This module is the
 * single source of truth.
 */

import { decodeRpc } from './codec.js'

export type WsMessage =
  | { kind: 'request'; id: string | number; method: string; params: unknown }
  | { kind: 'response'; id: string | number; result?: unknown; error?: { code: number; message: string } }
  | { kind: 'event'; event: string; data: unknown }
  | { kind: 'notification'; method: string; params: unknown }

/**
 * Decode + classify a single msgpack frame. Accepts `string` (Bun may
 * deliver text frames for legacy/debug clients) or `Uint8Array` (the
 * normal binary case). Returns `null` for malformed / unrecognized
 * shapes (caller drops the frame).
 */
export function classifyWsMessage(raw: string | Uint8Array): WsMessage | null {
  const buf = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw
  if (typeof raw === 'string') {
    throw new Error('this should never happen')
  }
  let parsed: unknown
  try {
    parsed = decodeRpc(buf).value
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  // Response envelope: has `id` and either `result` or `error`.
  if ('id' in obj && ('result' in obj || 'error' in obj)) {
    return { kind: 'response', id: obj.id as string | number, result: obj.result, error: obj.error as { code: number; message: string } | undefined }
  }
  // Legacy event envelope: `{event, data}`.
  if (typeof obj.event === 'string') {
    return { kind: 'event', event: obj.event, data: obj.data }
  }
  // Request envelope: `{id, method, params?}`.
  if ('id' in obj && typeof obj.method === 'string') {
    return { kind: 'request', id: obj.id as string | number, method: obj.method, params: obj.params }
  }
  // Notification envelope: `{method, params?}` (no `id`).
  if (typeof obj.method === 'string') {
    return { kind: 'notification', method: obj.method, params: obj.params }
  }
  return null
}