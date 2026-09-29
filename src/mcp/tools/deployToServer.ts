/**
 * `deployToServer` tool — v1 stub.
 *
 * # Purpose
 *
 * Deploy the rebuilt pack from `.sandstone/output/` to a remote
 * Minecraft server (SSH, FTP, `mcsmanager-login`, etc.).
 *
 * # Why this exists
 *
 * The `integrated` host provider runs the MC server as a child process
 * — same host as the build. The watcher writes build output directly
 * to the integrated server's directory (or symlinks it in via
 * `saveOptions.root`), so a separate deploy step is unnecessary in
 * that mode.
 *
 * Other host providers (`ssh`, `ftp`, `local-client`, `mcsmanager-login`)
 * talk to an externally-managed MC instance. The build output lives on
 * THIS machine; the server lives elsewhere. Without an explicit deploy
 * step, the rebuilt datapack never reaches the server.
 *
 * `deployToServer` fills that gap.
 *
 * # Design constraints (still TBD)
 *
 *   - **Opt-in, not every build.** Pushing every rebuild would burn
 *     wire bandwidth for nothing. Most users want fast iteration on
 *     the local build; only deploy when the user asks.
 *
 *   - **Mode-aware.** Must error (or warn loudly) when the daemon's
 *     host provider is `integrated` — there's nothing to deploy. When
 *     the daemon isn't running at all, the agent should fall back to
 *     the `sand build` Bash command (no deploy step exists).
 *
 *   - **Wire-shape to settle.** Reads `saveOptions.{serverPath,
 *     clientPath, world}` for the deploy target. Probably copies
 *     `.sandstone/output/datapack` into `<serverPath>/world/datapacks/`
 *     via the host provider's writeFile capability (SSH SCP, FTP
 *     STOR, etc.). Final design depends on how `saveOptions` evolves.
 *
 * # Current behavior
 *
 * Stub. Returns an actionable error pointing the agent at the Bash
 * fallback (`sand build` + manual copy). Real implementation deferred
 * until the sandstone-config work settles.
 */

import type { McpContext } from '../daemon-client.js'

export const NAME = 'deployToServer'

export const DESCRIPTION =
  'Deploy the rebuilt pack from `.sandstone/output/` to the configured Minecraft server. ' +
  'USAGE: only useful when the daemon\'s host provider is **NOT `integrated`** — i.e. when the server is remote (SSH/FTP/`mcsmanager-login`) and the build output needs to be copied over the wire. ' +
  'For `integrated` hosts the watcher writes build output directly to the local server directory, so deploy is a no-op. ' +
  'For each rebuild this is OPT-IN (not automatic) — pushing every build would waste wire bandwidth. ' +
  'CURRENT STATE: v1 stub. Returns an actionable error — use `sand build` via Bash and copy `.sandstone/output/datapack` to `<serverPath>/world/datapacks/` for now. ' +
  'Real implementation is blocked on sandstone-config changes that are still in flight.'

export async function call(
  _ctx: McpContext,
  _args: { dry?: boolean },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return {
    isError: true,
    content: [{
      type: 'text',
      text:
        '`deployToServer` is a v1 stub. Implementation is blocked on pending sandstone-config changes.\n\n' +
        'For now, run `sand build` via Bash and copy the result from `.sandstone/output/datapack/` ' +
        'to your server\'s `world/datapacks/` directory.\n\n' +
        'When this ships, it\'ll be useful ONLY when the `sand connect` daemon\'s host provider is NOT `integrated` ' +
        '(i.e. SSH / FTP / `mcsmanager-login`) — i.e. when the build output needs to be copied over the wire to a remote MC instance. ' +
        'For `integrated` hosts the watcher writes directly to the local server directory, so this tool is unnecessary there. ' +
        'And it\'s opt-in per rebuild — pushing every build would waste wire bandwidth.',
    }],
  }
}