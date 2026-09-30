/**
 * Shared `--host-config` / `--host-config-file` parsing.
 *
 * Used by `sand connect` (src/commands/connect/index.ts) and
 * `sand run` (src/commands/run.ts). Centralises:
 *   - JSON shape validation (must be an object),
 *   - sensitive-key warning (ps aux can see argv),
 *   - "exactly one of --host-config / --host-config-file" check.
 */

import { isObject } from '../../utils/guards.js'
import type { HostConfigInput } from '../../hosts/types.js'

/** Keys we never want to appear in `--host-config` (visible in `ps aux`). */
const SENSITIVE_KEYS = ['privateKey', 'password', 'cookie', 'token']

export interface HostConfigParseResult {
  config: HostConfigInput
  /** Sensitive-key warnings to surface to the user. */
  warnings: string[]
}

/**
 * Parse either `--host-config <json>` or `--host-config-file <path>`.
 * Exactly one must be supplied; both throws `HostConfigCliError`
 * with a user-actionable message. JSON that isn't an object throws
 * with the same. Sensitive-key hits generate warnings (non-fatal).
 *
 * On no-input, returns `{}` (empty config — caller applies defaults
 * via `bootstrap.resolveDefaults`).
 */
export class HostConfigCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostConfigCliError'
  }
}

export async function parseHostConfig(
  inline: string | undefined,
  filePath: string | undefined,
  readFile: (path: string) => Promise<string> = (p) => Bun.file(p).text(),
): Promise<HostConfigParseResult> {
  if (inline && filePath) {
    throw new HostConfigCliError(
      'Pass either --host-config or --host-config-file, not both',
    )
  }
  const warnings: string[] = []
  if (inline) {
    let parsed: unknown
    try {
      parsed = JSON.parse(inline)
    } catch (err) {
      throw new HostConfigCliError(
        `--host-config must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!isObject(parsed)) {
      throw new HostConfigCliError('--host-config must be a JSON object')
    }
    const hit = SENSITIVE_KEYS.find((k) =>
      inline.toLowerCase().includes(k.toLowerCase()),
    )
    if (hit) {
      warnings.push(
        `--host-config contains '${hit}'; this is visible in \`ps aux\`. ` +
          `Prefer --host-config-file with \`chmod 0600\`.`,
      )
    }
    return { config: parsed as HostConfigInput, warnings }
  }
  if (filePath) {
    const raw = await readFile(filePath)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new HostConfigCliError(
        `--host-config-file ${filePath} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!isObject(parsed)) {
      throw new HostConfigCliError(
        `--host-config-file ${filePath} must be a JSON object`,
      )
    }
    return { config: parsed as HostConfigInput, warnings: [] }
  }
  return { config: {}, warnings: [] }
}