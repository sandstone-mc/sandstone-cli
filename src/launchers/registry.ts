import type { LauncherProvider, LauncherType, DiscoveryResult } from './types.js'

const providers = new Map<LauncherType, LauncherProvider>()

/** Register a launcher provider */
export function registerProvider(provider: LauncherProvider): void {
  providers.set(provider.type, provider)
}

/** Get all registered providers */
export function getProviders(): LauncherProvider[] {
  return Array.from(providers.values())
}

/** Get a specific provider by type */
export function getProvider(type: LauncherType): LauncherProvider | undefined {
  return providers.get(type)
}

/** Discover instances from all registered providers */
export async function discoverAllInstances(): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    instances: [],
    errors: new Map(),
  }

  const discoveries = await Promise.allSettled(
    getProviders().map(async (provider) => {
      const instances = await provider.discoverInstances()
      return { type: provider.type, instances }
    })
  )

  for (const discovery of discoveries) {
    if (discovery.status === 'fulfilled') {
      result.instances.push(...discovery.value.instances)
    } else {
      // Extract the provider type from the error if possible
      const error = discovery.reason as Error
      // We can't easily get the type here, so we'll handle errors differently
      console.error('Discovery error:', error.message)
    }
  }

  return result
}
