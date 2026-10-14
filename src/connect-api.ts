/**
 * Public surface of the `sand connect` machinery for in-process consumers.
 *
 * This file is exposed as the `sandstone-cli/connect` subpath export — see
 * the `exports` map in `sandstone-cli/package.json`. It re-exports the
 * pieces an external test driver (e.g. `sandstone/tests/integration/setup.ts`)
 * needs to drive a running `sand connect` daemon without spawning extra
 * subprocesses for the WS protocol.
 */

export { Client } from './commands/connect/client.ts'
export { readEndpoint, writeEndpoint, pidAlive, endpointPath, type EndpointFile } from './commands/connect/endpoint-file.ts'
export { NULL_LOGGER, CONSOLE_LOGGER, createDaemonLogger } from './commands/connect/logger.ts'