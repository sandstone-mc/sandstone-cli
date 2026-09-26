/**
 * Orchestrator for the host-provider test suite.
 *
 * `beforeAll` brings up the Docker harness from scratch (build +
 * start + wait healthy + wait for MC's "Done (" + copy the SSH
 * key), `afterAll` tears it down. Per-test setup mkdtemps a project
 * root for the `sand connect` daemon to write its endpoint file into,
 * `afterEach` cleans that up.
 *
 * The actual host tests live in `ssh.test.ts` and `ftp.test.ts`,
 * each exporting a `register…Tests(getCfg, getProjectRoot)`
 * function. We call both here, in the same `beforeAll` scope, so
 * the SSH and FTP tests share the harness lifecycle.
 *
 * Run with:
 *   bun test tests/hosts/
 *
 * Or skip the harness auto-management (faster local iteration):
 *   TEST_SKIP_HARNESS=1 bun test tests/hosts/
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
} from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadHostConfig } from './_harness.ts'
import {
  cleanupProject,
  ensureHarnessUp,
  SSH_KEY_TEST_PATH,
  teardownHarness,
  type HarnessConfig,
} from './_daemon.ts'
import { registerFtpTests } from './ftp.test.ts'
import { registerSshTests } from './ssh.test.ts'

// Default config — the harness always binds these ports, so the
// suite is self-contained. Override via env to run against a
// non-default harness (e.g. a remote one).
const defaults = {
  TEST_SSH_HOST: 'localhost',
  TEST_SSH_PORT: '2222',
  TEST_SSH_USER: 'mctest',
  TEST_SSH_PASSWORD: 'testpass',
  TEST_SSH_KEY_PATH: SSH_KEY_TEST_PATH,
  TEST_FTP_HOST: 'localhost',
  TEST_FTP_PORT: '8235',
  TEST_FTP_USER: 'mctest',
  TEST_FTP_PASSWORD: 'testpass',
  // Kept for future composite tests (rcon, mcsmanager-login).
  TEST_RCON_HOST: 'localhost',
  TEST_RCON_PORT: '25575',
  TEST_RCON_PASSWORD: 'testpass',
  TEST_SERVER_DIR: '/home/mctest/server',
}
for (const [k, v] of Object.entries(defaults)) {
  if (process.env[k] === undefined) process.env[k] = v
}

// Suite-scoped state populated by `beforeAll`.
let cfg: HarnessConfig

// Per-test project root — every test gets its own `sand connect`
// endpoint file via a fresh mkdtempSync, torn down in afterEach.
let projectRoot: string

beforeAll(async () => {
  await ensureHarnessUp()
  cfg = loadHostConfig()
}, 300_000)

afterAll(async () => {
  await teardownHarness()
}, 30_000)

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'sandstone-host-'))
})

afterEach(async () => {
  await cleanupProject(projectRoot)
})

// Register both host suites. The registration functions are called
// inside this module's top-level scope, so the `describe` blocks
// they create inherit the beforeAll/afterAll/afterEach above.
registerSshTests(() => cfg, () => projectRoot)
registerFtpTests(() => cfg, () => projectRoot)
