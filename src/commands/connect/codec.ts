/**
 * Wire codec for the `sand connect` WebSocket protocol.
 *
 * Every RPC envelope (`RpcRequest`, `RpcResponse`, `RpcEvent`,
 * `StreamControl`) travels on a single binary WS frame as a
 * msgpack-encoded object. File payloads are NOT in the envelope —
 * they ride on separate binary frames tagged with a 16-byte
 * streamId (see {@link encodeStreamChunk}).
 *
 * msgpack over binary WS frames avoids the JSON+base64 round-trip
 * we used to do for `readFile`/`writeFile`, and gives the wire
 * protocol a binary-friendly shape for future streaming calls
 * (wholesale file copies, raw log dumps, etc.).
 */
import { Decoder, Encoder, type ExtData } from '@msgpack/msgpack'

/** Reusable encoder/decoder — msgpack is stateless and thread-safe. */
const encoder = new Encoder({ useBigInt64: false })
const decoder = new Decoder({ useBigInt64: false })

/** Encode an RPC envelope into a single msgpack object. */
export function encodeRpc(value: unknown): Uint8Array {
  return encoder.encode(value)
}

/**
 * Decode one msgpack object from `buf`. Returns the decoded value
 * plus any bytes after the encoded object (currently always empty —
 * WS delivers whole frames — but supported for future stream reuse).
 */
export function decodeRpc(buf: Uint8Array): { value: unknown; leftover: Uint8Array } {
  const value = decoder.decode(buf)
  return { value, leftover: new Uint8Array(0) }
}

/**
 * Prepend a 16-byte streamId to a chunk. The receiver strips the
 * prefix and routes the remainder to the matching stream state.
 *
 * streamId is the raw 16-byte UUID, not the hex form — keeps the
 * on-wire prefix at exactly 16 bytes regardless of length.
 */
export function encodeStreamChunk(streamId: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (streamId.length !== 16) {
    throw new Error(`streamId must be 16 bytes, got ${streamId.length}`)
  }
  const out = new Uint8Array(16 + chunk.length)
  out.set(streamId, 0)
  out.set(chunk, 16)
  return out
}

/** Inverse of {@link encodeStreamChunk}. */
export function decodeStreamChunk(buf: Uint8Array): { streamId: Uint8Array; chunk: Uint8Array } {
  if (buf.length < 16) {
    throw new Error(`stream frame too short: ${buf.length} bytes`)
  }
  const streamId = buf.slice(0, 16)
  const chunk = buf.slice(16)
  return { streamId, chunk }
}

/** Render a 16-byte UUID streamId as a 32-char hex string for log lines. */
export function streamIdHex(streamId: Uint8Array): string {
  return hexFromBytes(streamId)
}

/** Alias for {@link streamIdHex} — exposed for the client side. */
export function hexFromBytes(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

/** Generate a new 16-byte streamId from the OS CSPRNG. */
export function newStreamId(): Uint8Array {
  // crypto.randomUUID() returns a 36-char string like
  // "550e8400-e29b-41d4-a716-446655440000" — strip dashes to get
  // 32 hex chars (16 bytes), then convert to bytes. Cheap and
  // collision-resistant.
  const hex = crypto.randomUUID().replaceAll('-', '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** Inverse of {@link streamIdHex}: parse a 32-char hex string into 16 bytes. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 32) throw new Error(`streamId must be 32 hex chars, got ${hex.length}`)
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// Quiet the linter for the unused ExtData type — we may need it if
// future envelopes carry tagged binary blobs (e.g. stream chunks
// inlined into an envelope for small files).
void (null as unknown as ExtData)