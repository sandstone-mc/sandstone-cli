/**
 * Host capability dispatch helpers.
 *
 * Most RPC handlers follow the same shape: capability check via the
 * closure-captured `currentHost`, then either call the host's method
 * or throw `UnsupportedCapabilityRpc`. The runHost() / notImplemented()
 * / capable() trio encodes that pattern; this module is the
 * typesafe wrapper that handlers compose with.
 */

import { RpcErrorCode, type RpcError } from './rpc.js'
import type { Capability, HostProvider } from '../../hosts/types.js'

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

/**
 * Type-safe wrapper for the `runHost((h) => (h.METHOD ?? notImplemented(C)).bind(h)())`
 * pattern. Validates the host has `cap` AND implements `hostMethod`,
 * then invokes `hostMethod(host)` under `currentHost`.
 *
 * The closure capture of `currentHost` lives outside this helper
 * (it's set by `withHost` per dispatch). Callers don't need to
 * thread the host through.
 */
export async function callHostCapability<T>(
  currentHost: HostProvider | null,
  cap: Capability,
  hostMethod: (h: HostProvider) => Promise<T>,
): Promise<T> {
  if (!currentHost) {
    throw { code: RpcErrorCode.NotConnected, message: 'No host available' }
  }
  if (!currentHost.capabilities.has(cap)) {
    throw new UnsupportedCapabilityRpc(cap)
  }
  return hostMethod(currentHost)
}