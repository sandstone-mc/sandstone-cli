#!/usr/bin/env bun
/**
 * Manual harness control + thin test runner for `tests/hosts/`.
 *
 * Subcommands:
 *   up      bring the harness up via `docker compose up -d --build`
 *           and wait for it to be healthy
 *   down    tear the harness down via `docker compose down -v`
 *   status  print whether the harness is up + healthy
 *   test    run `bun test tests/hosts/` against the harness
 *           (the test itself auto-detects whether it needs to
 *           bring the harness up — see `ensureHarnessUp` in
 *           `tests/hosts/_daemon.ts`)
 *
 * The test harness (`host.test.ts::beforeAll`) automatically:
 *   - skips harness bringup when the container is already running
 *     (so `bun test` after `bun scripts/test-docker.ts up` is a no-op
 *     for the harness)
 *   - brings the harness up + tears it down if it wasn't already
 *     running (so `bun test` works standalone too)
 *
 * Run:
 *   bun scripts/test-docker.ts test
 *
 * Or directly (no script needed):
 *   bun test tests/hosts/
 */
const COMPOSE_FILE = 'tests/docker/docker-compose.yml'
const CONTAINER = 'sandstone-cli-host-test'

function log(step: string, msg = ''): void {
  const ts = new Date().toISOString().slice(11, 19)
  process.stdout.write(`[test-docker ${ts}] ${step}${msg ? `: ${msg}` : ''}\n`)
}

async function dockerCompose(...args: string[]): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', '-f', COMPOSE_FILE, ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} exited ${code}`)
  }
}

async function containerStatus(): Promise<'missing' | 'stopped' | 'starting' | 'healthy' | 'unhealthy'> {
  const proc = Bun.spawn(
    ['docker', 'inspect', '--format', '{{.State.Health.Status}}|{{.State.Status}}', CONTAINER],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const [health, state] = out.trim().split('|')
  if (state === 'exited' || state === 'dead' || state === 'removing') return 'stopped'
  if (!state) return 'missing'
  if (health === 'healthy') return 'healthy'
  if (health === 'unhealthy') return 'unhealthy'
  return 'starting'
}

async function waitForHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let poll = 0
  while (Date.now() < deadline) {
    poll++
    const s = await containerStatus()
    log('health', `poll ${poll}: status=${s}`)
    if (s === 'healthy') return
    if (s === 'unhealthy') {
      throw new Error(`harness container is unhealthy`)
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error(`harness did not become healthy within ${timeoutMs}ms`)
}

async function up(): Promise<number> {
  log('up', `docker compose -f ${COMPOSE_FILE} up -d --build`)
  await dockerCompose('up', '-d', '--build')
  await waitForHealthy(180_000) // MC cold start + asset download
  return 0
}

async function down(): Promise<number> {
  log('down', `docker compose -f ${COMPOSE_FILE} down -v`)
  try {
    await dockerCompose('down', '-v', '--remove-orphans')
  } catch {
    // Already gone — fine.
  }
  return 0
}

async function printStatus(): Promise<number> {
  const s = await containerStatus()
  log('status', s)
  return s === 'healthy' ? 0 : 1
}

async function main(): Promise<number> {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'up':
      return await up()
    case 'down':
      return await down()
    case 'status':
      return await printStatus()
    case undefined:
      console.error('Usage: bun scripts/test-docker.ts <up|down|status>')
      return 2
    default:
      console.error(`Unknown subcommand: ${cmd}`)
      return 2
  }
}

process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

export {}
process.exit(await main())
