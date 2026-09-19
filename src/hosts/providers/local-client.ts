import type { Subprocess } from 'bun'

import { Capability, type HostCapabilities, type HostProvider, type LocalClientHostConfig, type LogChunkHandler, type LogSubscription } from '../types.js'
import { spawn as shellSpawn } from '../../utils/shell.js'

/**
 * LocalClient provider — passive log observer of a launcher-managed
 * Minecraft client. Tails `${clientPath}/logs/latest.log` (or `logPath`
 * override) via `tail -F`. No start/stop/exec/files capability — the
 * external launcher owns the client process.
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
    // async iteration; stderr is drained silently (tail prints
    // "file truncated" notices there).
    const child: Subprocess = shellSpawn(['tail', '-F', logPath], {
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