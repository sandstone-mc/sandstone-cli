/**
 * Tiny type-guard helpers used across the daemon CLI, MCP, and host layers.
 */

/** `true` iff `v` is a non-null, non-array object. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}