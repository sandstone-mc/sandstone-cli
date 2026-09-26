/**
 * SshHost end-to-end tests. Exposes `registerSshTests()` which the
 * orchestrator (`host.test.ts`) calls inside its own beforeAll scope
 * so the SSH tests share the harness lifecycle with the FTP tests.
 *
 * The harness itself is brought up once, in `host.test.ts`'s
 * beforeAll — the registration function just receives the already-
 * loaded config and the per-test projectRoot.
 */
import { describe, expect, test } from 'bun:test'

import { openDaemonClient, runSand, startDaemon, type HarnessConfig } from './_daemon.ts'

export function registerSshTests(
  getCfg: () => HarnessConfig,
  getProjectRoot: () => string,
): void {
  describe('SshHost — connect daemon lifecycle', () => {
    test('sand connect boots an SSH+rcon daemon against the harness', async () => {
      const cfg = getCfg()
      const projectRoot = getProjectRoot()
      const sshHostConfig = JSON.stringify({
        ssh: {
          host: cfg.ssh.host,
          port: cfg.ssh.port,
          username: cfg.ssh.username,
          password: cfg.ssh.password,
          serverDir: cfg.serverDir,
          startCommand: 'true',
          stopCommand: 'true',
          // SshHost's default `'logs/latest.log'` is relative; with
          // no basePath it stays relative, and basic-ftp resolves it
          // against the user's CWD. Pin to the absolute MC log
          // path.
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
        hostType: 'ssh,rcon',
        hostConfig: sshHostConfig,
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

  describe('SshHost — attachLog via composite (ssh + rcon)', () => {
    test(
      'sand run "say <tag>" drives MC via RCON — exit 0 means RCON dispatched',
      async () => {
        const cfg = getCfg()
        const projectRoot = getProjectRoot()
        const sshHostConfig = JSON.stringify({
          ssh: {
            host: cfg.ssh.host,
            port: cfg.ssh.port,
            username: cfg.ssh.username,
            password: cfg.ssh.password,
            serverDir: cfg.serverDir,
            startCommand: 'true',
            stopCommand: 'true',
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
          hostType: 'ssh,rcon',
          hostConfig: sshHostConfig,
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
        const sshHostConfig = JSON.stringify({
          ssh: {
            host: cfg.ssh.host,
            port: cfg.ssh.port,
            username: cfg.ssh.username,
            password: cfg.ssh.password,
            serverDir: cfg.serverDir,
            startCommand: 'true',
            stopCommand: 'true',
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
          hostType: 'ssh,rcon',
          hostConfig: sshHostConfig,
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
