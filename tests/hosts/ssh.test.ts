/**
 * SshHost end-to-end tests. Exposes `registerSshTests()` which the
 * orchestrator (`host.test.ts`) calls inside its own beforeAll scope
 * so the SSH tests share the harness lifecycle with the FTP tests.
 *
 * The harness itself is brought up once, in `host.test.ts`'s
 * beforeAll — the registration function just receives the already-
 * loaded config and the per-test projectRoot.
 *
 * SSH's built-in `execCommand` is reserved for `startCommand` /
 * `stopCommand` (lifecycle). For `executeRawCommand` we open a
 * separate rcon-srcds client via the optional `rcon` block under
 * the ssh config — same pattern as FtpHost.
 */
import { describe, expect, test } from 'bun:test'

import { openDaemonClient, runSand, startDaemon, type HarnessConfig } from './_daemon.ts'

export function registerSshTests(
  getCfg: () => HarnessConfig,
  getProjectRoot: () => string,
): void {
  // SSH-only config — no RCON. Skips `executeRawCommand` capability.
  // The SSH exec channel is reserved for start/stop commands, which
  // these tests stub out as `true` so nothing actually launches.
  // Host config is flat (HostConfigInput is the union of all
  // provider configs); no `ssh:` wrapper.
  const sshOnlyConfig = (cfg: HarnessConfig): string =>
    JSON.stringify({
      host: cfg.ssh.host,
      port: cfg.ssh.port,
      username: cfg.ssh.username,
      password: cfg.ssh.password,
      serverDir: cfg.serverDir,
      startCommand: 'true',
      stopCommand: 'true',
      // SshHost's default `'logs/latest.log'` is relative; with
      // no basePath it stays relative, and the SFTP layer resolves
      // it against the user's CWD. Pin to the absolute MC log path.
      logPath: `${cfg.serverDir}/logs/latest.log`,
    })

  // SSH+RCON — exposes `executeRawCommand`. `rcon` config is a flat
  // sibling of the other SshHost fields since SshHost owns its rcon
  // client directly (no composite layer).
  const sshRconConfig = (cfg: HarnessConfig): string =>
    JSON.stringify({
      host: cfg.ssh.host,
      port: cfg.ssh.port,
      username: cfg.ssh.username,
      password: cfg.ssh.password,
      serverDir: cfg.serverDir,
      startCommand: 'true',
      stopCommand: 'true',
      logPath: `${cfg.serverDir}/logs/latest.log`,
      rcon: {
        host: cfg.rcon.host,
        port: cfg.rcon.port,
        password: cfg.rcon.password,
      },
    })

  describe('SshHost — connect daemon lifecycle', () => {
    test('sand connect boots an SSH-only daemon against the harness', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ssh',
        hostConfig: sshOnlyConfig(cfg),
      })
      try {
        expect(daemon.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
        expect(daemon.port).toBeGreaterThan(0)
        expect(daemon.proc.exitCode).toBeNull()
      } finally {
        await daemon.shutdown()
      }
    }, 30_000)
  })

  describe('SshHost — file I/O (via WS RPC)', () => {
    test('writeFile then readFile round-trip matches the original payload', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ssh',
        hostConfig: sshOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `${cfg.serverDir}/.ssh-rpc-roundtrip-${Date.now()}.txt`
        const payload = `ssh round-trip ${Date.now()}\n`
        // `writeFile` accepts a string directly — UTF-8 encoded before
        // streaming to the daemon.
        await client.writeFile({ path, data: payload })
        // `readFile({encode: 'utf-8'})` decodes the stream server-side
        // and returns the file as a string.
        const back = await client.readFile({ path, encode: 'utf-8' })
        expect(back.data).toBe(payload)
      } finally {
        client.close()
        await daemon.shutdown()
      }
    }, 30_000)

    test('readFile of an existing MC server file returns its content', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ssh',
        hostConfig: sshOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `${cfg.serverDir}/server.properties`
        const back = await client.readFile({ path, encode: 'utf-8' })
        expect(back.data).toContain('enable-rcon=true')
        expect(back.data).toContain('rcon.port=25575')
      } finally {
        client.close()
        await daemon.shutdown()
      }
    }, 30_000)

    test('readFile on a missing path surfaces an RPC error', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ssh',
        hostConfig: sshOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `${cfg.serverDir}/.ssh-rpc-missing-${Date.now()}.txt`
        await expect(client.readFile({ path })).rejects.toThrow()
      } finally {
        client.close()
        await daemon.shutdown()
      }
    }, 30_000)

    test('writeFileStream then readFileStream round-trip matches the original payload', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ssh',
        hostConfig: sshOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `${cfg.serverDir}/.ssh-stream-roundtrip-${Date.now()}.txt`
        const payload = `ssh stream round-trip ${Date.now()}\n`
        const bytes = new TextEncoder().encode(payload)
        // Write via the streaming API — feed the source ReadableStream
        // a single chunk (close signals end-of-write).
        const writeSource = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        })
        const writeResult = await client.writeFileStream({
          path,
          stream: writeSource,
          size: bytes.byteLength,
        })
        const { bytesWritten } = await writeResult.done
        expect(bytesWritten).toBe(bytes.byteLength)
        // Read back via the streaming API — drain the ReadableStream
        // and accumulate chunks into a single buffer.
        const readResult = await client.readFileStream({ path })
        const reader = readResult.stream.getReader()
        let accumulated = new Uint8Array(0)
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          const next = new Uint8Array(accumulated.byteLength + value.byteLength)
          next.set(accumulated, 0)
          next.set(value, accumulated.byteLength)
          accumulated = next
        }
        expect(new TextDecoder().decode(accumulated)).toBe(payload)
      } finally {
        client.close()
        await daemon.shutdown()
      }
    }, 30_000)

    test('writeFileStream coalesces a multi-chunk payload into the SFTP write stream', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ssh',
        hostConfig: sshOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `${cfg.serverDir}/.ssh-stream-multichunk-${Date.now()}.bin`
        // 5 MiB split into 32 KiB frames — forces many WS chunks
        // through ssh2's SFTP WriteStream and exercises the
        // streaming path end-to-end.
        const pieceA = new Uint8Array(2_097_374).fill(0x5a)
        const pieceB = new Uint8Array(2_097_374).fill(0xa5)
        const tail = new Uint8Array(2_097_374 - 1).fill(0x7e)
        const payload = new Uint8Array(pieceA.byteLength + pieceB.byteLength + tail.byteLength)
        payload.set(pieceA, 0)
        payload.set(pieceB, pieceA.byteLength)
        payload.set(tail, pieceA.byteLength + pieceB.byteLength)
        const totalSize = payload.byteLength
        const FRAME = 32 * 1024
        const writeSource = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < totalSize; i += FRAME) {
              controller.enqueue(payload.subarray(i, Math.min(i + FRAME, totalSize)))
            }
            controller.close()
          },
        })
        const writeResult = await client.writeFileStream({
          path,
          stream: writeSource,
          size: totalSize,
        })
        await writeResult.done
        // Read back byte-for-byte.
        const readResult = await client.readFileStream({ path })
        const reader = readResult.stream.getReader()
        let accumulated = new Uint8Array(0)
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          const next = new Uint8Array(accumulated.byteLength + value.byteLength)
          next.set(accumulated, 0)
          next.set(value, accumulated.byteLength)
          accumulated = next
        }
        expect(accumulated.byteLength).toBe(totalSize)
        expect(accumulated).toEqual(payload)
      } finally {
        client.close()
        await daemon.shutdown()
      }
    }, 60_000)

    test('readFileStream on a missing path surfaces an RPC error', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ssh',
        hostConfig: sshOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `${cfg.serverDir}/.ssh-stream-missing-${Date.now()}.txt`
        // SSH's fast-fail on `stat()` means the dispatch throws
        // synchronously and the readFile RPC error envelope arrives
        // before `readFileStream` can resolve — so the surface-level
        // promise rejects with the host error.
        await expect(client.readFileStream({ path })).rejects.toThrow()
      } finally {
        client.close()
        await daemon.shutdown()
      }
    }, 30_000)
  })

  describe('SshHost — attachLog + RCON', () => {
    test(
      'sand run "say <tag>" drives MC via RCON — exit 0 means RCON dispatched',
      async () => {
        const cfg = getCfg()
        const projectRoot = getProjectRoot()
        const daemon = await startDaemon({
          projectRoot,
          hostType: 'ssh',
          hostConfig: sshRconConfig(cfg),
        })
        try {
          const tag = `sshattach${Date.now()}`
          const { exitCode } = await runSand([`say ${tag}`], projectRoot)
          expect(exitCode).toBe(0)
        } finally {
          await daemon.shutdown()
        }
      },
      30_000,
    )

    test(
      'WS client attachLog picks up MC log lines driven by RCON `say`',
      async () => {
        const cfg = getCfg()
        const projectRoot = getProjectRoot()
        const daemon = await startDaemon({
          projectRoot,
          hostType: 'ssh',
          hostConfig: sshRconConfig(cfg),
        })
        const client = await openDaemonClient(daemon)
        try {
          const sub = await client.attachLog()
          const received: string[] = []
          sub.onLines((lines) => {
            for (const line of lines) received.push(line)
          })
          try {
            const tag = `sshstream${Date.now()}`
            for (let i = 0; i < 10; i++) {
              await client.executeRawCommand({ command: `say ${tag}${i}` })
            }
            const start = Date.now()
            while (
              Date.now() - start < 15_000 &&
              !received.some((l) => l.includes(tag))
            ) {
              await new Promise((r) => setTimeout(r, 100))
            }
            const hit = received.find((l) => l.includes(tag))
            expect(hit).toBeDefined()
          } finally {
            await sub.unattach()
          }
        } finally {
          client.close()
          await daemon.shutdown()
        }
      },
      60_000,
    )
  })
}