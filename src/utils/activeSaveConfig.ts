/**
 * Resolved deployment config — the "save config" — extracted to its
 * own module so the `sand connect` daemon (and `sand mcp`) can type
 * the wire payload without pulling in the full build pipeline.
 *
 * Source of truth for both:
 *   - the watcher (publishes to daemon via `publishConfig` RPC),
 *   - the build pipeline (consumes via `local.worldName` /
 *     `local.clientPath` / etc. inside `_buildProject`).
 *
 * The helper {@link resolveActiveSaveConfig} lives in
 * `commands/build/index.ts` because it needs `BuildOptions`; both
 * sites share the merge rules via that single helper.
 */

export interface ActiveSaveConfig {
  /** World name under `<clientPath>/saves/`. */
  world?: string
  /** Whether the pack installs as a root project. */
  root?: boolean
  /** Client `.minecraft` (or launcher instance) directory. */
  clientPath?: string
  /** Dedicated server directory. */
  serverPath?: string
}