/**
 * Helper for `tests/hosts/*.test.ts`. Reads `TEST_*` env vars set by
 * `scripts/test-docker.ts` and exposes them as a typed config object.
 *
 * If the harness env vars are missing (e.g. someone runs `bun test
 * tests/` without first starting the harness), every test that calls
 * `loadHostConfig()` throws a clear error pointing at
 * `bun run test:docker`. Tests do not silently skip — silent skips
 * hide broken CI pipelines.
 */
import { readFileSync } from 'node:fs'

export interface SshTestConfig {
  host: string
  port: number
  username: string
  password: string
  privateKey?: string | Buffer
  /** Absolute path on the container where MC is installed. */
  serverDir: string
}

export interface FtpTestConfig {
  host: string
  port: number
  user: string
  password: string
  /** Optional basePath prefix prepended to every FTP path. */
  basePath?: string
}

export interface RconTestConfig {
  host: string
  port: number
  password: string
}

export interface HarnessConfig {
  ssh: SshTestConfig
  ftp: FtpTestConfig
  rcon: RconTestConfig
  /** Absolute path on the container where MC is installed. */
  serverDir: string
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(
      `Harness env var ${name} is not set. Run \`bun run test:docker\` to start the test harness, or set the var manually.`,
    )
  }
  return v
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined
}

let cached: HarnessConfig | undefined

/** Read harness config from env. Cached for the lifetime of the process. */
export function loadHostConfig(): HarnessConfig {
  if (cached) return cached

  const serverDir = required('TEST_SERVER_DIR')

  const ssh: SshTestConfig = {
    host: required('TEST_SSH_HOST'),
    port: Number(required('TEST_SSH_PORT')),
    username: required('TEST_SSH_USER'),
    password: required('TEST_SSH_PASSWORD'),
    serverDir,
  }
  const keyPath = optional('TEST_SSH_KEY_PATH')
  if (keyPath) {
    // node-ssh validates that `privateKey` is a string — Buffers (the
    // default of readFileSync) are rejected with `config.privateKey
    // must be a valid string`. Convert to UTF-8 so PEM bytes survive.
    ssh.privateKey = readFileSync(keyPath, 'utf8')
  }

  cached = {
    ssh,
    ftp: {
      host: required('TEST_FTP_HOST'),
      port: Number(required('TEST_FTP_PORT')),
      user: required('TEST_FTP_USER'),
      password: required('TEST_FTP_PASSWORD'),
      basePath: optional('TEST_FTP_BASE_PATH'),
    },
    rcon: {
      host: required('TEST_RCON_HOST'),
      port: Number(required('TEST_RCON_PORT')),
      password: required('TEST_RCON_PASSWORD'),
    },
    serverDir,
  }
  return cached
}