import type { DaemonLogger } from '../commands/connect/logger.js'
import type { HostProvider, HostType, HostCapabilities } from './types.js'

interface HostProviderFactory {
  readonly type: HostType
  readonly displayName: string
  readonly capabilities: HostCapabilities
  create(config: any, logger: DaemonLogger): HostProvider
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