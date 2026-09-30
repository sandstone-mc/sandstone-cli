/**
 * Shared signal handler installation. Both the daemon child
 * (`sand connect`) and any long-lived parent process need SIGINT /
 * SIGTERM / SIGBREAK (Windows) routed to the same teardown sequence.
 */

/**
 * Register SIGINT / SIGTERM (and SIGBREAK on Windows) handlers that
 * call `onSignal(sig)`. Windows-only `process.on('SIGBREAK')` is
 * wrapped in a try (it's absent on POSIX) so the same call works
 * everywhere.
 *
 * The handlers are registered once per call; repeated invocations
 * stack the new handler alongside existing ones (Node's EventEmitter
 * semantics). Callers that need a single registration should call
 * this exactly once at boot.
 */
export function installShutdownSignals(
  onSignal: (sig: NodeJS.Signals) => void,
): void {
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  if (process.platform === 'win32') {
    process.on('SIGBREAK', onSignal)
  }
}