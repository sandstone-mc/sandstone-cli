import type { Subprocess } from 'bun'

import { Capability, type HostCapabilities, type HostProvider, type LocalClientHostConfig, type LogChunkHandler, type LogSubscription } from '../types.js'
import { spawn as shellSpawn } from '../../utils/shell.js'

/**
 * LocalClient provider — passive log observer of a launcher-managed
 * Minecraft client. Tails `${clientPath}/logs/latest.log` (or `logPath`
 * override) via `tail -F` (POSIX) or PowerShell `Get-Content -Wait`
 * (Windows). No start/stop/exec/files capability — the external
 * launcher owns the client process.
 *
 * `connect()`/`disconnect()` are no-ops for the log-tail itself (no
 * session to establish), but the interface still requires them, so they
 * flip an internal flag.
 */
export class LocalClientHost implements HostProvider {
  readonly type = 'local-client' as const
  readonly displayName = 'Local Client'
  readonly capabilities: HostCapabilities = new Set([Capability.AttachLog])

  private readonly config: LocalClientHostConfig
  private connected = false

  constructor(config: LocalClientHostConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async attachLog(onChunk: LogChunkHandler): Promise<LogSubscription> {
    const logPath =
      this.config.logPath ?? `${this.config.clientPath}/logs/latest.log`

    // shellSpawn wraps Bun.spawn (returns Subprocess). Read stdout via
    // async iteration; stderr is drained silently (tail / Get-Content
    // both print "file truncated"/rotation notices there).
    //
    // POSIX: `tail -F -n 0` skips existing content and starts tailing
    // from the current end-of-file — subscribers get only lines emitted
    // after they subscribed (consistent with the integrated host, which
    // streams live JVM stdout from spawn). `-F` (capital) follows
    // rotations by inode, so a renamed `latest.log` keeps streaming.
    //
    // Windows: PowerShell `Get-Content -Tail 0 -Wait` is the equivalent
    // — `-Tail 0` starts at EOF, `-Wait` blocks for new lines. Run via
    // `powershell.exe -NoProfile -Command` so we don't shell-quote via
    // cmd.exe. The path is wrapped in single quotes inside the PS
    // command string; PowerShell accepts single-quoted literals
    // verbatim, so paths with spaces or `$` survive unchanged.
    const child: Subprocess = process.platform === 'win32'
      ? shellSpawn(
          [
            'powershell',
            '-NoProfile',
            '-Command',
            `Get-Content -Path '${logPath.replace(/'/g, `''`)}' -Tail 0 -Wait`,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
      : shellSpawn(['tail', '-F', '-n', '0', logPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

    let buffer = ''
    let stopped = false

    const flushLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (lines.length > 0) onChunk(lines)
    }

    const decoder = new TextDecoder('utf-8')
    void (async () => {
      try {
        const stream = child.stdout as ReadableStream<Uint8Array<ArrayBufferLike>>
        for await (const chunk of stream) {
          if (stopped) break
          buffer += decoder.decode(chunk, { stream: true })
          flushLines()
        }
      } catch {
        // ignore — tail exits on its own when the pipe is closed
      }
    })()
    void (async () => {
      try {
        const stream = child.stderr as ReadableStream<Uint8Array<ArrayBufferLike>>
        for await (const _ of stream) {
          /* swallow tail's stderr notices */
        }
      } catch {
        // ignore
      }
    })()

    return {
      async unattach() {
        if (stopped) return
        stopped = true
        if (!child.killed) child.kill('SIGTERM')
        if (buffer.length > 0) {
          onChunk([buffer])
          buffer = ''
        }
      },
    }
  }
}

/** Factory used by the registry. */
export function createLocalClientHost(config: LocalClientHostConfig): HostProvider {
  return new LocalClientHost(config)
}