import { DaemonUnavailableError } from '../daemon-client.js'
import { type McpBridge } from '../bridge.js'
import { deployDatapack, type DeployResult } from '../../commands/deploy.js'
import { raceAbort } from './_raceAbort.js'

export const NAME = 'deployToServer'

export const DESCRIPTION =
  'Upload the rebuilt datapack from `.sandstone/output/` to the remote Minecraft server. ' +
  'Use only when the `sand connect` daemon\'s host provider is NOT `integrated` — for integrated hosts, ' +
  'the build already symlinks the pack into the local server directory and deploy is unnecessary. ' +
  'Requires `writeFileStream` on the daemon\'s capabilities and a populated `.sandstone/output/datapack/` ' +
  '(run `sand build` or `sand watch` first). ' +
  'No-op when nothing changed since the last deploy; otherwise uploads the changed archives, ' +
  'and runs `/reload` automatically if the daemon exposes `executeRawCommand`.'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function summarize(result: DeployResult): string {
  const uploaded = [result, ...result.dependencies].filter((r) => !r.unchanged)
  const unchanged = [result, ...result.dependencies].filter((r) => r.unchanged)
  const bytesUploaded = uploaded.reduce((sum, r) => sum + r.bytesWritten, 0)

  const lines: string[] = []
  if (result.unchanged && result.dependencies.every((d) => d.unchanged)) {
    lines.push(`Nothing to deploy — all ${unchanged.length} archive(s) match the server state.`)
  } else {
    lines.push(`Deployed ${uploaded.length} archive(s) (${formatBytes(bytesUploaded)}):`)
    if (!result.unchanged) {
      lines.push(`  ${result.archiveName} -> ${result.remotePath} (${formatBytes(result.bytesWritten)})`)
    }
    for (const dep of result.dependencies) {
      if (dep.unchanged) continue
      lines.push(`  ${dep.name} -> ${dep.remotePath} (${formatBytes(dep.bytesWritten)})`)
    }
    if (unchanged.length > 0) {
      lines.push(`Skipped (unchanged): ${unchanged.length} archive(s)`)
    }
  }
  if (result.reloaded) {
    lines.push(`Reload: ok`)
  } else if (!result.unchanged && result.dependencies.every((d) => d.unchanged)) {
    // unreachable — nothing-changed case handled above
  } else if (!result.reloaded) {
    lines.push(`Reload: skipped (daemon has no executeRawCommand — run /reload manually)`)
  }
  return lines.join('\n')
}

export async function call(
  bridge: McpBridge,
  _args: Record<string, never>,
  _signal?: AbortSignal,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  let daemonClient
  try {
    daemonClient = await bridge.requireDaemon()
  } catch (err) {
    if (err instanceof DaemonUnavailableError) throw err
    const message = err instanceof Error ? err.message : String(err)
    return {
      isError: true,
      content: [{ type: 'text', text: `Cannot reach \`sand connect\` daemon: ${message}\n\nStart one with \`sand connect\` before calling this tool.` }],
    }
  }

  const welcome = daemonClient.welcome
  if (welcome.hostType === 'integrated') {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `Host is \`integrated\` — deploy is unnecessary. The build symlinks pack output directly into ` +
          `the integrated server's world/datapacks/ directory; there is nothing to upload over the wire.`,
      }],
    }
  }
  if (welcome.capabilities['writeFileStream'] !== true) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `Host '${welcome.hostType}' does not advertise the \`writeFileStream\` capability. ` +
          `Deploy requires streaming file writes — check the host config.`,
      }],
    }
  }

  try {
    const result = await raceAbort(deployDatapack({ daemon: daemonClient, projectRoot: bridge.ctx.projectRoot }), _signal)
    return {
      content: [{
        type: 'text',
        text:
          `Host: ${welcome.hostType}\n` +
          `${summarize(result)}\n\n` +
          `Local archive: ${result.archivePath}`,
      }],
    }
  } catch (err) {
    if (err instanceof DaemonUnavailableError) throw err
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('deployed but reload failed')) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `${message}\n\nThe deploy itself succeeded; the server didn't reload. Run \`/reload\` manually.`,
        }],
      }
    }
    return { isError: true, content: [{ type: 'text', text: `Deploy failed: ${message}` }] }
  }
}