/**
 * End-to-end tests for the SSH host provider, driven via `sand
 * connect --host-type ssh,rcon --host-config <json>`, `sand run`,
 * and a typed WS client against the daemon.
 *
 * The Docker harness (`tests/docker/`) must be running — the test
 * runner brings it up before invoking bun test.
 *
 * What this verifies:
 *   - `sand connect` can construct an SshHost from CLI config
 *     (connect() lifecycle works against the harness).
 *   - A composite of [SshHost, RconHost] works end-to-end:
 *     `sand run "say <tag>"` sends `say` via RCON, exit 0.
 *   - The SSH attachLog actually fires: subscribe via the WS
 *     client, drive MC's log with a burst of `say` commands
 *     through RCON, and assert the tag lands in the
 *     subscription's line batches.
 *   - `sand connect --shutdown` cleanly tears the daemon down.
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
  projectRoot = mkdtempSync(join(tmpdir(), 'sandstone-ssh-'))
})

afterEach(async () => {
  await cleanupProject(projectRoot)
})

const sshHostConfig = JSON.stringify({
  ssh: {
    host: cfg.ssh.host,
    port: cfg.ssh.port,
    username: cfg.ssh.username,
    password: cfg.ssh.password,
    serverDir: cfg.serverDir,
    startCommand: 'true',
    stopCommand: 'true',
    // SshHost's default `'logs/latest.log'` is relative; with no
    // basePath it stays relative, and basic-ftp resolves it
    // against the user's CWD. Pin to the absolute MC log path
    // for the same reason we do in the FTP test.
    logPath: `${cfg.serverDir}/logs/latest.log`,
  },
  rcon: {
    host: cfg.rcon.host,
    port: cfg.rcon.port,
    password: cfg.rcon.password,
  },
})

describe('SshHost — connect daemon lifecycle', () => {
  test('sand connect boots an SSH+rcon daemon against the harness', async () => {
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
      const daemon = await startDaemon({
        projectRoot,
        hostType: 'ssh,rcon',
        hostConfig: sshHostConfig,
      })
      const client = await openDaemonClient(daemon)
      try {
        // ssh2's SFTP ReadStream pushes EOF the first time a READ
        // returns 0 bytes. The SshHost.sftp-stream strategy seeds
        // an active background writer before subscribing so the
        // stream sees bytes at every poll and stays open. Without
        // that, even an actively-growing file ends the stream
        // after the first empty read and the attachLog subscription
        // never fires.
        //
        // We don't have a direct knob for "active writer" via the
        // WS RPC alone (it'd take a separate process to keep the
        // file growing during subscribe). Instead we rely on the
        // fact that MC's RCON listener + server thread write log
        // lines constantly during boot, autosave, and listener
        // events. Driving a burst of `say` commands gives us
        // enough churn for the SFTP stream to surface chunks.
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
          // SFTP stream batches + daemon → client forwarding
          // can take a couple of seconds. 15s is comfortable.
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