#!/usr/bin/env bun
/**
 * Test runner for `tests/hosts/` — assumes the Docker harness
 * (`tests/docker/`) is already up and the SSH key is at
 * `.temp/test-harness/ssh-key`.
 *
 * The container lifecycle (up/down/key-copy/healthcheck) is
 * currently managed out-of-band so this script can stay simple
 * and fast. To bring the harness up from scratch, run the
 * snippets documented in the README / CLAUDE.md — the user is
 * iterating on the harness itself, so we avoid destroying it on
 * every test run.
 *
 * Usage:
 *   bun run scripts/test-docker.ts
 */
import { $ } from 'bun'

function log(step: string, msg = ''): void {
  const ts = new Date().toISOString().slice(11, 19)
  process.stdout.write(`[test-docker ${ts}] ${step}${msg ? `: ${msg}` : ''}\n`)
}

const env = {
  TEST_SSH_HOST: 'localhost',
  TEST_SSH_PORT: '2222',
  TEST_SSH_USER: 'mctest',
  TEST_SSH_PASSWORD: 'testpass',
  TEST_SSH_KEY_PATH: '.temp/test-harness/ssh-key',
  TEST_FTP_HOST: 'localhost',
  TEST_FTP_PORT: '8235',
  TEST_FTP_USER: 'mctest',
  TEST_FTP_PASSWORD: 'testpass',
  // RCON env vars are NOT consumed by tests in this pass; they are
  // set here so a future pass can add rcon.test.ts and/or composite
  // ssh+rcon / ftp+rcon tests without re-templating this script.
  TEST_RCON_HOST: 'localhost',
  TEST_RCON_PORT: '25575',
  TEST_RCON_PASSWORD: 'testpass',
  TEST_SERVER_DIR: '/home/mctest/server',
}

async function runTests(): Promise<number> {
  log('tests', 'spawning bun test tests/hosts/')
  const proc = Bun.spawn(['bun', 'test', 'tests/hosts/'], {
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  log('tests', `bun test exited ${code}`)
  return code
}

async function main(): Promise<void> {
  let exitCode = 1
  try {
    exitCode = await runTests()
  } catch (err) {
    log('error', err instanceof Error ? err.message : String(err))
    exitCode = 1
  }
  log('exit', String(exitCode))
  process.exit(exitCode)
}

process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

await main()