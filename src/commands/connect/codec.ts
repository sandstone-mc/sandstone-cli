import { Decoder, Encoder } from '@msgpack/msgpack'

const encoder = new Encoder({ useBigInt64: false })
const decoder = new Decoder({ useBigInt64: false })

export function encodeRpc(value: unknown): Uint8Array {
  return encoder.encode(value)
}

export function decodeRpc(buf: Uint8Array): { value: unknown; leftover: Uint8Array } {
  const value = decoder.decode(buf)
  return { value, leftover: new Uint8Array(0) }
}

export const STREAM_MAGIC = 0xc1

export function encodeStreamChunk(streamId: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (streamId.length !== 16) {
    throw new Error(`streamId must be 16 bytes, got ${streamId.length}`)
  }
  const out = new Uint8Array(1 + 16 + chunk.length)
  out[0] = STREAM_MAGIC
  out.set(streamId, 1)
  out.set(chunk, 17)
  return out
}

export function decodeStreamChunk(buf: Uint8Array): { streamId: Uint8Array; chunk: Uint8Array } {
  if (buf.length < 17) {
    throw new Error(`stream frame too short: ${buf.length} bytes`)
  }
  if (buf[0] !== STREAM_MAGIC) {
    throw new Error(`stream frame missing magic: got 0x${buf[0].toString(16)}`)
  }
  const streamId = buf.slice(1, 17)
  const chunk = buf.slice(17)
  return { streamId, chunk }
}

export function streamIdHex(streamId: Uint8Array): string {
  return hexFromBytes(streamId)
}

export function hexFromBytes(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

export function newStreamId(): Uint8Array {
  const hex = crypto.randomUUID().replaceAll('-', '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 32) throw new Error(`streamId must be 32 hex chars, got ${hex.length}`)
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
