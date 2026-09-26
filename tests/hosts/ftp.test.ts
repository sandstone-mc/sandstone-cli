/**
 * End-to-end tests for the FTP host provider, driven via `sand
 * connect --host-type ftp,rcon --host-config <json>` and a typed
 * WS client against the daemon.
 *
 * The Docker harness (`tests/docker/`) must be running — the test
 * runner brings it up before invoking bun test.
 *
 * Coverage:
 *   - `sand connect` boots a composite ftp+rcon daemon (verifies
 *     bootstrap shape detection unwraps the keyed `{ftp:{...}}`
 *     form, basic-ftp's `access()` succeeds against the live
 *     vsftpd, the WS server listens).
 *   - `readFile` / `writeFile` round-trip against MC's actual
 *     server dir (exercises both the FtpHost provider AND the
 *     vsftpd passive-port range that the harness maps 1:1).
 *   - `attachLog` driven via composite (rcon `say` → MC log →
 *     FtpHost poll picks up the new bytes).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadHostConfig } from './_harness.ts'
import { cleanupProject, openDaemonClient, runSand, startDaemon } from './_daemon.ts'

const cfg = loadHostConfig()
let projectRoot: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sandstone-ftp-'))
})

afterEach(async () => {
  await cleanupProject(projectRoot)
})

const ftpHostConfig = JSON.stringify({
  ftp: {
    host: cfg.ftp.host,
    port: cfg.ftp.port,
    user: cfg.ftp.user,
    password: cfg.ftp.password,
    // No basePath — paths passed to readFile/writeFile are absolute
    // and FtpHost prepends basePath when set, so leaving it out lets
    // us pass full paths straight through.
    //
    // logPath MUST be absolute. FtpHost's default `'logs/latest.log'`
    // is relative; with no basePath it stays relative, and basic-ftp
    // resolves it against the FTP user's CWD (`/home/mctest`) — so
    // the default would look for `/home/mctest/logs/latest.log`,
    // which doesn't exist. The poller would swallow the ENOENT
    // silently and never fire onChunk. Pin to the absolute MC log
    // path here.
    logPath: `${cfg.serverDir}/logs/latest.log`,
  },
  rcon: {
    host: cfg.rcon.host,
    port: cfg.rcon.port,
    password: cfg.rcon.password,
  },
})

describe('FtpHost — connect daemon lifecycle', () => {
  test('sand connect boots an ftp+rcon daemon against the harness', async () => {
    const daemon = await startDaemon({
      projectRoot,
      // `rcon,ftp` (RCON first) instead of `ftp,rcon` — when FTP
      // connects first under heavy MC I/O it can race with RCON's
      // auth and RCON gets ECONNRESET. RCON-first is the order
      // `sand connect` users have historically used and avoids the
      // race in this harness.
      hostType: 'rcon,ftp',
      hostConfig: ftpHostConfig,
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
    const daemon = await startDaemon({
      projectRoot,
      hostType: 'rcon,ftp',
      hostConfig: ftpHostConfig,
    })
    const client = await openDaemonClient(daemon)
    try {
      const path = `${cfg.serverDir}/.ftp-rpc-roundtrip-${Date.now()}.txt`
      const payload = `ftp round-trip ${Date.now()}\n`
      // writeFile RPC defaults to base64 — pass `encoding: 'utf-8'`
      // so the string lands on disk as text rather than as the
      // base64 representation of itself.
      await client.writeFile({ path, data: payload, encoding: 'utf-8' })
      const back = await client.readFile({ path })
      // readFile RPC always returns base64. Decode before comparing.
      const decoded = Buffer.from(back.data, 'base64').toString('utf-8')
      expect(decoded).toBe(payload)
    } finally {
      client.close()
      await daemon.shutdown()
    }
  }, 30_000)

  test('readFile of an existing MC server file returns its content', async () => {
    const daemon = await startDaemon({
      projectRoot,
      hostType: 'rcon,ftp',
      hostConfig: ftpHostConfig,
    })
    const client = await openDaemonClient(daemon)
    try {
      // server.properties is written by the harness entrypoint
      // from server.properties.tmpl; the live file lives at
      // ${serverDir}/server.properties.
      const path = `${cfg.serverDir}/server.properties`
      const back = await client.readFile({ path })
      // readFile RPC always returns base64 — decode before asserting.
      const decoded = Buffer.from(back.data, 'base64').toString('utf-8')
      expect(decoded).toContain('enable-rcon=true')
      expect(decoded).toContain('rcon.port=25575')
    } finally {
      client.close()
      await daemon.shutdown()
    }
  }, 30_000)

  test('readFile on a missing path surfaces an RPC error', async () => {
    const daemon = await startDaemon({
      projectRoot,
      hostType: 'rcon,ftp',
      hostConfig: ftpHostConfig,
    })
    const client = await openDaemonClient(daemon)
    try {
      const path = `${cfg.serverDir}/.ftp-rpc-missing-${Date.now()}.txt`
      await expect(client.readFile({ path })).rejects.toThrow()
    } finally {
      client.close()
      await daemon.shutdown()
    }
  }, 30_000)
})

describe('FtpHost — attachLog via composite (ftp + rcon)', () => {
  test(
    'rcon `say` triggers an MC log line that FtpHost attachLog picks up',
    async () => {
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'rcon,ftp',
        hostConfig: ftpHostConfig,
      })
      const client = await openDaemonClient(daemon)
      try {
        // Subscribe to the FTP host's log attachment. FtpHost
        // polls for new bytes via SIZE + STREAM download, so we
        // need the file to be actively growing under the
        // poller. Drive MC's log with `say` commands (one log
        // line each) via RCON through the same daemon.
        const sub = await client.attachLog()
        const received: string[] = []
        sub.onLines((lines) => {
          for (const line of lines) received.push(line)
        })
        try {
          const tag = `ftplog${Date.now()}`
          // Fire a burst so the file is growing while the poller's
          // first poll cycle runs. basic-ftp's poll+download takes
          // a couple of cycles before it surfaces new bytes.
          for (let i = 0; i < 5; i++) {
            await client.executeRawCommand({ command: `say ${tag}${i}` })
          }
          // Wait for any of the tags to land in `received`.
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

// `sand run` end-to-end through the same daemon, sanity-checking
// that RCON dispatch still works when the composite is ftp+rcon
// (not just ssh+rcon — same code path, different host members).
describe('FtpHost + RconHost — sand run dispatch', () => {
  test('sand run "say <tag>" exits 0 via the rcon member', async () => {
    const daemon = await startDaemon({
      projectRoot,
      hostType: 'rcon,ftp',
      hostConfig: ftpHostConfig,
    })
    try {
      const { exitCode } = await runSand([`say ftprcon${Date.now()}`], projectRoot)
      expect(exitCode).toBe(0)
    } finally {
      await daemon.shutdown()
    }
  }, 30_000)
})