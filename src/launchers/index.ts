// Re-export types
export type { LauncherType, MinecraftInstance, LauncherProvider, DiscoveryResult } from './types.js'

// Re-export registry functions
export { registerProvider, getProviders, getProvider, discoverAllInstances } from './registry.js'

// Import and register all built-in providers
import { registerProvider } from './registry.js'
import { vanillaProvider } from './providers/vanilla.js'
import { prismProvider } from './providers/prism.js'
import { modrinthProvider } from './providers/modrinth.js'

registerProvider(vanillaProvider)
registerProvider(prismProvider)
registerProvider(modrinthProvider)
