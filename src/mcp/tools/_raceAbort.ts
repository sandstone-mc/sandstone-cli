/**
 * Race a promise against an AbortSignal. If the signal fires, the
 * returned promise rejects with an `AbortError`. The underlying
 * promise keeps executing — there's no way to cancel a daemon RPC
 * without changing the client, so we just abandon it from the caller's
 * perspective.
 */
export class AbortError extends Error {
  constructor() {
    super('Operation aborted')
    this.name = 'AbortError'
  }
}

export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError())
      return
    }
    const onAbort = () => reject(new AbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}