// Re-export types
export type { LauncherType, MinecraftInstance, LauncherProvider, DiscoveryResult } from './types.js'

// Re-export registry functions
export { registerProvider, getProviders, getProvider, discoverAllInstances } from './registry.js'

// Re-export vanilla provider for callers that need its path directly
// (e.g. fallback when no launcher-specific instance was selected).
export { vanillaProvider } from './providers/vanilla.js'

// Import and register all built-in providers
import { registerProvider } from './registry.js'
import { vanillaProvider } from './providers/vanilla.js'
import { prismProvider } from './providers/prism.js'
import { modrinthProvider } from './providers/modrinth.js'
import { nitroProvider } from './providers/nitro.js'

registerProvider(vanillaProvider)
registerProvider(prismProvider)
registerProvider(modrinthProvider)
registerProvider(nitroProvider)
