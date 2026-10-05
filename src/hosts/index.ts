export type {
  HostType,
  HostCapabilities,
  Capability,
  LogSubscription,
  HostLogHandler,
  HostProvider,
  CapabilityMethods,
  HostConfigInput,
  SshHostConfig,
  FtpHostConfig,
  IntegratedHostConfig,
  McsManagerHostConfig,
} from './types.js'
export { HOST_TYPES, KNOWN_HOST_TYPES } from './types.js'
export { ALL_CAPABILITIES, capabilitiesToRecord } from './types.js'

export { registerProvider, getProvider, getProviders, createHost } from './registry.js'
export { UnsupportedCapabilityError, NotConnectedError, HostAuthError } from './errors.js'

import { registerProvider } from './registry.js'
import { createSshHost } from './providers/ssh.js'
import { createFtpHost } from './providers/ftp.js'
import { createIntegratedHost } from './providers/integrated.js'
import { createMcsManagerHost } from './providers/mcsmanager-login.js'
import { Capability } from './types.js'

registerProvider({
  type: 'ssh',
  displayName: 'SSH',
  capabilities: new Set([
    Capability.StartServer,
    Capability.StopServer,
    Capability.ReadFile,
    Capability.WriteFile,
    Capability.AttachLog,
  ]),
  create: createSshHost,
})

registerProvider({
  type: 'ftp',
  displayName: 'FTP',
  capabilities: new Set([
    Capability.ReadFile,
    Capability.WriteFile,
    Capability.AttachLog,
  ]),
  create: createFtpHost,
})

registerProvider({
  type: 'integrated',
  displayName: 'Integrated Fabric Server',
  capabilities: new Set([
    Capability.StartServer,
    Capability.StopServer,
    Capability.ReadFile,
    Capability.WriteFile,
    Capability.AttachLog,
    Capability.ExecuteRawCommand,
    Capability.ExecuteRawCommandHasResponse,
  ]),
  create: createIntegratedHost,
})

registerProvider({
  type: 'mcsmanager-login',
  displayName: 'MCSManager (Login)',
  capabilities: new Set([
    Capability.ReadFile,
    Capability.WriteFile,
    Capability.AttachLog,
    Capability.ExecuteRawCommand,
    Capability.ExecuteRawCommandHasResponse,
  ]),
  create: createMcsManagerHost,
})
