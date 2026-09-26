/**
 * FtpHost end-to-end tests. Exposes `registerFtpTests()` which the
 * orchestrator (`host.test.ts`) calls inside its own beforeAll scope
 * so the FTP tests share the harness lifecycle with the SSH tests.
 */
import { describe, expect, test } from 'bun:test'

import { openDaemonClient, runSand, startDaemon, type HarnessConfig } from './_daemon.ts'

export function registerFtpTests(
  getCfg: () => HarnessConfig,
  getProjectRoot: () => string,
): void {
  describe('FtpHost — connect daemon lifecycle', () => {
    test('sand connect boots an rcon+ftp daemon against the harness', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const ftpHostConfig = JSON.stringify({
        ftp: {
          host: cfg.ftp.host,
          port: cfg.ftp.port,
          user: cfg.ftp.user,
          password: cfg.ftp.password,
          // logPath MUST be absolute. FtpHost's default
          // `'logs/latest.log'` is relative; with no basePath it
          // stays relative, and basic-ftp resolves it against the
          // FTP user's CWD (`/home/mctest`) — so the default would
          // look for `/home/mctest/logs/latest.log`, which doesn't
          // exist. The poller would swallow the ENOENT silently and
          // never fire onChunk. Pin to the absolute MC log path.
          logPath: `${cfg.serverDir}/logs/latest.log`,
        },
        rcon: {
          host: cfg.rcon.host,
          port: cfg.rcon.port,
          password: cfg.rcon.password,
        },
      })
      const daemon = await startDaemon({
        projectRoot,
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
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const ftpHostConfig = JSON.stringify({
        ftp: {
          host: cfg.ftp.host,
          port: cfg.ftp.port,
          user: cfg.ftp.user,
          password: cfg.ftp.password,
          logPath: `${cfg.serverDir}/logs/latest.log`,
        },
        rcon: {
          host: cfg.rcon.host,
          port: cfg.rcon.port,
          password: cfg.rcon.password,
        },
      })
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
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const ftpHostConfig = JSON.stringify({
        ftp: {
          host: cfg.ftp.host,
          port: cfg.ftp.port,
          user: cfg.ftp.user,
          password: cfg.ftp.password,
          logPath: `${cfg.serverDir}/logs/latest.log`,
        },
        rcon: {
          host: cfg.rcon.host,
          port: cfg.rcon.port,
          password: cfg.rcon.password,
        },
      })
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'rcon,ftp',
        hostConfig: ftpHostConfig,
      })
      const client = await openDaemonClient(daemon)
      try {
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
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const ftpHostConfig = JSON.stringify({
        ftp: {
          host: cfg.ftp.host,
          port: cfg.ftp.port,
          user: cfg.ftp.user,
          password: cfg.ftp.password,
          logPath: `${cfg.serverDir}/logs/latest.log`,
        },
        rcon: {
          host: cfg.rcon.host,
          port: cfg.rcon.port,
          password: cfg.rcon.password,
        },
      })
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

  describe('FtpHost — attachLog via composite (rcon + ftp)', () => {
    test(
      'rcon `say` triggers an MC log line that FtpHost attachLog picks up',
      async () => {
        const cfg = getCfg()
        const projectRoot = getProjectRoot()
        const ftpHostConfig = JSON.stringify({
          ftp: {
            host: cfg.ftp.host,
            port: cfg.ftp.port,
            user: cfg.ftp.user,
            password: cfg.ftp.password,
            logPath: `${cfg.serverDir}/logs/latest.log`,
          },
          rcon: {
            host: cfg.rcon.host,
            port: cfg.rcon.port,
            password: cfg.rcon.password,
          },
        })
        const daemon = await startDaemon({
          projectRoot,
          hostType: 'rcon,ftp',
          hostConfig: ftpHostConfig,
        })
        const client = await openDaemonClient(daemon)
        try {
          const sub = await client.attachLog()
          const received: string[] = []
          sub.onLines((lines) => {
            for (const line of lines) received.push(line)
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
      },
      60_000,
    )
  })

  describe('FtpHost + RconHost — sand run dispatch', () => {
    test('sand run "say <tag>" exits 0 via the rcon member', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const ftpHostConfig = JSON.stringify({
        ftp: {
          host: cfg.ftp.host,
          port: cfg.ftp.port,
          user: cfg.ftp.user,
          password: cfg.ftp.password,
          logPath: `${cfg.serverDir}/logs/latest.log`,
        },
        rcon: {
          host: cfg.rcon.host,
          port: cfg.rcon.port,
          password: cfg.rcon.password,
        },
      })
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
}
