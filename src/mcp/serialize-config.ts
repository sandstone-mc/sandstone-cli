/**
 * Serializer helpers for MCP resource content.
 *
 * SandstoneConfig is a deep object with optional fields (`saveOptions`,
 * `packUid`, `mcmeta`, ...). When we want to emit it as plain text for
 * an LLM, we need a format that:
 *   - preserves the shape (no silent field drops — the agent should see
 *     "this key exists but isn't set" when relevant),
 *   - tolerates values TOML can't natively represent (`undefined` and
 *     `null` inside arrays — `Bun.TOML.stringify` throws on those),
 *   - is human-readable without being noisy.
 *
 * Two strategies depending on the consumer:
 *   - {@link sentinelizeNullish}: substitute `null`/`undefined` with the
 *     string sentinels `"<%null%>"` / `"<%undefined%>"` before TOML
 *     emission. Result: TOML valid, structure preserved, agent sees the
 *     placeholder.
 *   - {@link formatConfigAsToml}: convenience wrapper combining
 *     sentinelize + Bun.TOML.stringify.
 */

/**
 * Walk an arbitrary value, replacing `null` and `undefined` with the
 * string sentinels `"<%null%>"` and `"<%undefined%>"`. Implemented via
 * `JSON.stringify` replacer so we get a recursive walk for free —
 * avoids writing our own cycle-detecting visitor.
 *
 * Note: `JSON.stringify` already drops object-keyed `undefined`, so the
 * replacer mainly exists to:
 *   1. turn `null` → `"<%null%>"` (JSON would keep it as `null`),
 *   2. turn `undefined` inside arrays → `"<%undefined%>"` (JSON would
 *      emit `null` here, which we then want to also sentinelise).
 */
export function sentinelizeNullish<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, val) => {
      if (val === undefined) return '<%undefined%>'
      if (val === null) return '<%null%>'
      return val
    }),
  ) as T
}

/**
 * Format a `sandstone.config.ts` object as TOML for human-readable MCP
 * resource content. Roundtrip-safe for the string sentinels (they're
 * emitted as quoted TOML strings).
 *
 * Bun's TOML serializer throws on mixed null/undefined entries inside
 * arrays — the sentinel pass runs first so that's never reached.
 *
 * `Bun.TOML.stringify` exists at runtime (verified) but isn't yet in
 * Bun's TypeScript declarations (only `parse` is typed). The cast is
 * scoped to this one site.
 */
export function formatConfigAsToml(cfg: unknown): string {
  const safe = sentinelizeNullish(cfg)
  return (Bun.TOML as unknown as { stringify(v: unknown): string }).stringify(safe)
}