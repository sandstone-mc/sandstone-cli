/**
 * GitHub content fetcher.
 *
 * Prefers the `gh` CLI when available — uses the user's existing
 * `gh auth` session so private repos + rate limits are handled
 * transparently. Falls back to a direct `fetch` against the same URL,
 * using `GITHUB_TOKEN` env var for auth when present.
 *
 * The intended use is fetching raw content from
 * `https://raw.githubusercontent.com/...` and API endpoints from
 * `https://api.github.com/...`. Both URLs are passed through verbatim;
 * no path rewriting happens here.
 *
 * Public API:
 *   - `ghFetch(url, init?)` → `Response` (raw, callers parse)
 *   - `ghFetchText(url, init?)` → `string` (UTF-8 body, throws on non-2xx)
 *   - `ghAvailable()` → `boolean` (true if `gh` is on PATH)
 */

import { hasCommand, run } from './shell.js'

/** Returns true if `gh` is on PATH. Cached after first lookup. */
export async function ghAvailable(): Promise<boolean> {
  return hasCommand('gh')
}

/**
 * Fetch a URL (typically `raw.githubusercontent.com` or
 * `api.github.com`). Uses `gh api <url>` if available — that handles
 * authentication via the user's `gh auth` session. Falls back to a
 * direct `fetch`, adding a `Bearer` `Authorization` header when
 * `GITHUB_TOKEN` is set.
 *
 * Returns the raw `Response`. Callers parse the body themselves.
 */
export async function ghFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Response> {
  if (await ghAvailable()) {
    try {
      return await runGhApi(url, init)
    } catch {
      // Fall through to fetch. `gh` may have failed because of
      // missing auth, rate limits, network — the fetch fallback may
      // succeed in any of those cases if GITHUB_TOKEN is set.
    }
  }
  return await directFetch(url, init)
}

/**
 * Convenience wrapper that returns the body as UTF-8 text. Throws
 * `GhError` on non-2xx response.
 */
export async function ghFetchText(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<string> {
  const resp = await ghFetch(url, init)
  if (!resp.ok) {
    throw new GhError(
      `GitHub fetch ${url} failed: HTTP ${resp.status} ${resp.statusText}`,
      resp.status,
    )
  }
  return await resp.text()
}

// ---------------------------------------------------------------------
// gh CLI backend
// ---------------------------------------------------------------------

async function runGhApi(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Response> {
  const args = ['api', url]
  if (init?.method) args.push('-X', init.method)
  // Pass extra headers via `-H 'K: V'` pairs.
  for (const [k, v] of Object.entries(init?.headers ?? {})) {
    args.push('-H', `${k}: ${v}`)
  }
  const stdinBody =
    init?.body === undefined
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : JSON.stringify(init.body)
  if (stdinBody !== undefined) args.push('--input', '-')

  // `run` throws on non-zero exit by default; pass `throws: false` so
  // we can build a richer GhError ourselves from stderr.
  const result = await run('gh', args, { throws: false })
  if (result.exitCode !== 0) {
    const stderr = await result.stderr
    throw new GhError(
      `gh api ${url} exited with code ${result.exitCode}: ${stderr.toString().trim()}`,
      result.exitCode,
    )
  }
  // gh api doesn't expose status codes — exit code 0 means 2xx-ish.
  // Wrap stdout in a synthetic Response for the same shape as fetch.
  const stdout = await result.stdout
  return new Response(stdout, { status: 200 })
}

// ---------------------------------------------------------------------
// Direct fetch backend
// ---------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function directFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Response> {
  return await fetch(url, {
    method: init?.method ?? 'GET',
    headers: {
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
    ...(init?.body === undefined
      ? {}
      : {
          body:
            typeof init.body === 'string'
              ? init.body
              : (JSON.stringify(init.body) as RequestInit['body']),
        }),
  })
}

// ---------------------------------------------------------------------

export class GhError extends Error {
  constructor(message: string, public readonly code: number | null) {
    super(message)
    this.name = 'GhError'
  }
}