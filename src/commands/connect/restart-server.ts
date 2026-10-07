export interface RestartTarget {
  stopServer: () => Promise<void>
  startServer: () => Promise<void>
  welcome: { hostType: string; capabilities: Record<string, boolean> }
}

export interface RestartOptions {
  /** Sink for human-readable progress. CLI uses chalk, MCP drops this. */
  log?: (line: string) => void
}

export interface RestartResult {
  hostType: string
  elapsedMs: number
}

/**
 * Returns null if the host supports both stop+start, otherwise a user-facing
 * error string explaining which capability is missing and what to do instead.
 */
export function checkRestartCapabilities(welcome: RestartTarget['welcome']): string | null {
  const caps = welcome.capabilities
  if (!caps.stopServer && !caps.startServer) {
    return (
      `Daemon host \`${welcome.hostType}\` supports neither stopServer nor startServer — it can't manage the server lifecycle. ` +
      `For \`local-client\` hosts the launcher owns the lifecycle (use the launcher UI). ` +
      `For pure \`rcon\` hosts the server lifecycle is external.`
    )
  }
  if (!caps.stopServer) {
    return (
      `Daemon host \`${welcome.hostType}\` supports startServer but not stopServer. ` +
      `Use the host's own lifecycle controls (e.g. launcher UI for local-client) — restart needs both.`
    )
  }
  if (!caps.startServer) {
    return (
      `Daemon host \`${welcome.hostType}\` supports stopServer but not startServer. ` +
      `Use the host's own lifecycle controls.`
    )
  }
  return null
}

export async function restartServer(
  target: RestartTarget,
  opts: RestartOptions = {},
): Promise<RestartResult> {
  const capabilityError = checkRestartCapabilities(target.welcome)
  if (capabilityError) {
    throw new Error(capabilityError)
  }

  const log = opts.log ?? (() => {})
  const startedAt = Date.now()
  log(`Stopping MC server...`)
  try {
    await target.stopServer()
  } catch (err) {
    throw new Error(
      `Failed to stop the server: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  log(`Starting MC server...`)
  try {
    await target.startServer()
  } catch (err) {
    throw new Error(
      `Server stopped but failed to restart: ${err instanceof Error ? err.message : String(err)}. ` +
        `The daemon is alive and the server may need a manual start.`,
    )
  }

  return { hostType: target.welcome.hostType, elapsedMs: Date.now() - startedAt }
}