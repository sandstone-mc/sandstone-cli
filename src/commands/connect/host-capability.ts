/**
 * Host capability dispatch helpers.
 *
 * Handlers reach the host via `internals.host` and either call the
 * host's method or throw `UnsupportedCapabilityRpc`. This module
 * provides the error type plus a small throw-helper.
 */

import type { RpcError } from './rpc.js'

/** Error returned to the wire when a host advertises a capability but doesn't implement the method. */
export class UnsupportedCapabilityRpc extends Error {
  constructor(public readonly capability: string) {
    super(`Unsupported capability: ${capability}`)
    this.name = 'UnsupportedCapabilityError'
  }
}

/**
 * Throw an RpcError. Convenience — `rpcError(code, msg)` then `throw`.
 */
export function rpcError(code: number, message: string): RpcError {
  return { code, message }
}

/** Adapter for {@link UnsupportedCapabilityRpc} that throws a plain `Error` (tests, fallback path). */
export function notImplemented(method: string): never {
  throw new Error(`Host advertises capability but does not implement: ${method}`)
}