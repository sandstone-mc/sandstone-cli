/**
 * FtpHost end-to-end tests. Exposes `registerFtpTests()` which the
 * orchestrator (`host.test.ts`) calls inside its own beforeAll scope
 * so the FTP tests share the harness lifecycle with the SSH tests.
 *
 * FTP itself has no native exec channel — RCON is configured under
 * the ftp config block (since rcon-srcds is intrinsic to FtpHost now,
 * not a separate composite member). Tests that don't need
 * `executeRawCommand` omit the `rcon` block entirely.
 */
import { describe, expect, test } from 'bun:test'

import { openDaemonClient, runSand, startDaemon, type HarnessConfig } from './_daemon.ts'

export function registerFtpTests(
  getCfg: () => HarnessConfig,
  getProjectRoot: () => string,
): void {
  // FTP-only config — no RCON. Skips `executeRawCommand` capability.
  // Host config is flat (HostConfigInput is the union of all
  // provider configs); no `ftp:` wrapper. The CLI parses the
  // `--host-config` JSON and routes it to the matching provider.
  const ftpOnlyConfig = (cfg: HarnessConfig): string =>
    JSON.stringify({
      host: cfg.ftp.host,
      port: cfg.ftp.port,
      user: cfg.ftp.user,
      password: cfg.ftp.password,
      // FtpHost resolves every relative path against `serverPath`
      // (see `resolvePath` in `providers/ftp.ts`), so without it
      // every `readFile`/`attachLog` throws
      // `undefined is not an object (evaluating '...serverPath.replace')`.
      serverPath: cfg.serverDir,
      // logPath is resolved against serverPath by FtpHost —
      // passing it absolute would double-prefix (`resolvePath`
      // prepends serverPath to every path, including absolute
      // ones) and the FTP poller would `SIZE` a non-existent file.
      logPath: 'logs/latest.log',
    })

  // FTP+RCON — exposes `executeRawCommand`. `rcon` config is a flat
  // sibling of the other FtpHost fields since FtpHost owns its rcon
  // client directly (no composite layer).
  const ftpRconConfig = (cfg: HarnessConfig): string =>
    JSON.stringify({
      host: cfg.ftp.host,
      port: cfg.ftp.port,
      user: cfg.ftp.user,
      password: cfg.ftp.password,
      serverPath: cfg.serverDir,
      logPath: 'logs/latest.log',
      rcon: {
        host: cfg.rcon.host,
        port: cfg.rcon.port,
        password: cfg.rcon.password,
      },
    })

  describe('FtpHost — connect daemon lifecycle', () => {
    test('sand connect boots an FTP-only daemon against the harness', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ftp',
        hostConfig: ftpOnlyConfig(cfg),
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

  describe('FtpHost — file I/O (via WS RPC)', () => {
    test('writeFile then readFile round-trip matches the original payload', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ftp',
        hostConfig: ftpOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `.ftp-rpc-roundtrip-${Date.now()}.txt`
        const payload = `ftp round-trip ${Date.now()}\n`
        // `writeFile` accepts a string directly — it's UTF-8 encoded
        // before streaming to the daemon.
        await client.writeFile({ path, data: payload })
        // `readFile({encode: 'utf-8'})` decodes the stream server-side
        // and returns the file as a string.
        const back = await client.readFile({ path, encode: 'utf-8' })
        expect(back).toBe(payload)
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
        hostType: 'ftp',
        hostConfig: ftpOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `server.properties`
        const back = await client.readFile({ path, encode: 'utf-8' })
        expect(back).toContain('enable-rcon=true')
        expect(back).toContain('rcon.port=25575')
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
        hostType: 'ftp',
        hostConfig: ftpOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `.ftp-rpc-missing-${Date.now()}.txt`
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
        hostType: 'ftp',
        hostConfig: ftpOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `.ftp-stream-roundtrip-${Date.now()}.txt`
        const payload = `ftp stream round-trip ${Date.now()}\n`
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

    test('writeFileStream coalesces a multi-piece payload into upload-piece calls', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ftp',
        hostConfig: ftpOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `.ftp-stream-multichunk-${Date.now()}.bin`
        // 5 MiB split into 32 KiB frames — forces the coalescing
        // loop in FtpHost's writeFileStream to flush several PIECE_SIZE
        // (~2 MiB) upload-piece requests back-to-back.
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
        hostType: 'ftp',
        hostConfig: ftpOnlyConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const path = `.ftp-stream-missing-${Date.now()}.txt`
        // FTP's fast-fail on `size()` means the dispatch throws
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

  describe('FtpHost + rcon — sand run dispatch', () => {
    test('sand run "say <tag>" exits 0 via the ftp host\'s rcon', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ftp',
        hostConfig: ftpRconConfig(cfg),
      })
      try {
        const { exitCode } = await runSand([`say ftprcon${Date.now()}`], projectRoot)
        expect(exitCode).toBe(0)
      } finally {
        await daemon.shutdown()
      }
    }, 30_000)

    test('WS client executeRawCommand triggers an MC log line that FtpHost attachLog picks up', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ftp',
        hostConfig: ftpRconConfig(cfg),
      })
      const client = await openDaemonClient(daemon)
      try {
        const sub = await client.attachLog()
        const received: string[] = []
        sub.onLines((lines) => {
          for (const l of lines) received.push(l.line)
        })
        try {
          const tag = `ftplog${Date.now()}`
          for (let i = 0; i < 5; i++) {
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
    }, 60_000)
  })
}