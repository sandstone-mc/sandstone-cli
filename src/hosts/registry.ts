import type { HostProvider, HostType, HostCapabilities } from './types.js'

/**
 * Registry pattern lifted from `src/launchers/registry.ts` with one twist:
 * the launcher registry stores connected `LauncherProvider` instances; host
 * providers need per-connection config, so the registry stores *factories*
 * instead and `createHost(type, config)` instantiates + connects.
 *
 * Public surface still centers on `HostProvider` for callers — the factory
 * type is internal.
 */

interface HostProviderFactory {
  readonly type: HostType
  readonly displayName: string
  readonly capabilities: HostCapabilities
  create(config: any): HostProvider
}

const factories = new Map<HostType, HostProviderFactory>()

export function registerProvider(factory: HostProviderFactory): void {
  if (factories.has(factory.type)) {
    throw new Error(`Host provider "${factory.type}" is already registered`)
  }
  factories.set(factory.type, factory)
}

export function getProvider(type: HostType): HostProviderFactory | undefined {
  return factories.get(type)
}

export function getProviders(): HostProviderFactory[] {
  return Array.from(factories.values())
}

/**
 * Instantiate the provider for `type` with `config`, then `connect()` it.
 * Throws if `type` is not registered or if `connect()` fails.
 */
export async function createHost<T extends HostProvider = HostProvider>(
  type: HostType,
  config: any,
): Promise<T> {
  const factory = factories.get(type)
  if (!factory) {
    throw new Error(`Host provider "${type}" is not registered`)
  }
  const host = factory.create(config) as T
  await host.connect()
  return host
}

/** Test-only / advanced: drop all factories. Not part of the public API. */
export function __resetRegistryForTests(): void {
  factories.clear()
}