/**
 * Errors thrown by the hosts subsystem. All extend `Error` and carry a
 * distinct `name` so callers can `instanceof`-check or pattern-match on it.
 */

/**
 * Composite throws this when no member declares a capability (or the member
 * that does lacks the corresponding method).
 */
export class UnsupportedCapabilityError extends Error {
  constructor(public readonly capability: string) {
    super(`Host provider does not support capability: ${capability}`)
    this.name = 'UnsupportedCapabilityError'
  }
}

/**
 * Thrown by providers when a capability method is called before `connect()`
 * has resolved or after `disconnect()`.
 */
export class NotConnectedError extends Error {
  constructor(providerType?: string) {
    super(providerType ? `${providerType} host is not connected` : 'Host is not connected')
    this.name = 'NotConnectedError'
  }
}

/**
 * Thrown on auth failures (bad RCON password, MCSManager login rejection,
 * EULA not accepted, etc).
 */
export class HostAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostAuthError'
  }
}