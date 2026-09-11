// Public surface + side-effect registrations.
//
// Importing this module (or any module that imports it) registers every
// built-in host provider into the registry. Consumers then either:
//   - `createHost('ssh', sshConfig)` to get a connected HostProvider
//   - `new CompositeHost([sshHost, rconHost])` for composed multi-provider hosts
//
// Mirrors `src/launchers/index.ts`.

export type {
  HostType,
  ServerPath,
  HostCapabilities,
  LogSubscription,
  LogChunkHandler,
  LogChunkFanoutHandler,
  HostProvider,
  CapabilityMethods,
  SshHostConfig,
  RconHostConfig,
  FtpHostConfig,
  LocalClientHostConfig,
  IntegratedHostConfig,
  McsManagerHostConfig,
} from './types.js'
export { ALL_CAPABILITIES_OFF, ALL_CAPABILITIES_ON, mergeCapabilities } from './types.js'

export { registerProvider, getProvider, getProviders, createHost } from './registry.js'
export { CompositeHost } from './composite.js'
export { UnsupportedCapabilityError, NotConnectedError, HostAuthError } from './errors.js'

// Side-effect: register all built-in providers.
import { registerProvider } from './registry.js'
import { createSshHost } from './providers/ssh.js'
import { createRconHost } from './providers/rcon.js'
import { createFtpHost } from './providers/ftp.js'
import { createLocalClientHost } from './providers/local-client.js'
import { createIntegratedHost } from './providers/integrated.js'
import { createMcsManagerHost } from './providers/mcsmanager-login.js'

registerProvider({
  type: 'ssh',
  displayName: 'SSH',
  capabilities: {
    startServer: true,
    stopServer: true,
    readFile: true,
    writeFile: true,
    attachLog: true,
    executeRawCommand: false,
  },
  create: createSshHost,
})

registerProvider({
  type: 'rcon',
  displayName: 'RCON',
  capabilities: {
    startServer: false,
    stopServer: false,
    readFile: false,
    writeFile: false,
    attachLog: false,
    executeRawCommand: true,
  },
  create: createRconHost,
})

registerProvider({
  type: 'ftp',
  displayName: 'FTP',
  capabilities: {
    startServer: false,
    stopServer: false,
    readFile: true,
    writeFile: true,
    attachLog: true,
    executeRawCommand: false,
  },
  create: createFtpHost,
})

registerProvider({
  type: 'local-client',
  displayName: 'Local Client',
  capabilities: {
    startServer: false,
    stopServer: false,
    readFile: false,
    writeFile: false,
    attachLog: true,
    executeRawCommand: false,
  },
  create: createLocalClientHost,
})

registerProvider({
  type: 'integrated',
  displayName: 'Integrated Fabric Server',
  capabilities: {
    startServer: true,
    stopServer: true,
    readFile: true,
    writeFile: true,
    attachLog: true,
    executeRawCommand: true,
  },
  create: createIntegratedHost,
})

registerProvider({
  type: 'mcsmanager-login',
  displayName: 'MCSManager (Login)',
  capabilities: {
    startServer: false,
    stopServer: false,
    readFile: true,
    writeFile: true,
    attachLog: true,
    executeRawCommand: true,
  },
  create: createMcsManagerHost,
})