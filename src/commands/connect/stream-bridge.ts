/**
 * WS streamEnd / streamError bridge.
 *
 * The dispatch's `streams.open({onClose})` callback fires once per
 * stream for success (bytes) or failure (err). For both directions
 * (server-side inbound readFile + outbound writeFile) the bridge
 * encodes the matching envelope and sends it on the wire.
 *
 * Centralizing the envelope shape keeps server.ts / dispatch.ts in
 * sync — every stream-end path uses the same event name + payload
 * structure, no drift between success and error cases.
 */

import { encodeRpc } from './codec.js'
import { event } from './rpc.js'

export interface StreamEndBridge {
  /** Send `streamEnd` for a clean close. */
  (bytes: number): void
  /** Send `streamError` for an aborted close. */
  (bytes: number, err: Error): void
}

/**
 * Build a closure that emits a `streamEnd` envelope (on `bytes`) or
 * a `streamError` envelope (on `(bytes, err)`) to `ws`. Tolerates a
 * missing `ws` (test stubs) and a closed connection (send throws).
 *
 * Use as the `onClose` callback for `streams.open({...})`:
 *
 *   streams.open({
 *     streamId,
 *     ...
 *     onClose: makeStreamEndBridge(ws, streamId),
 *   })
 */
export function makeStreamEndBridge(
  ws: { send(data: Uint8Array): void } | undefined,
  streamId: string,
): StreamEndBridge {
  return ((bytes: number, err?: Error) => {
    try {
      if (err) {
        ws?.send(
          encodeRpc(
            event('streamError', {
              streamId,
              code: 0,
              message: err.message,
            }),
          ),
        )
      } else {
        ws?.send(encodeRpc(event('streamEnd', { streamId, bytes })))
      }
    } catch {
      // Peer disconnected mid-close — session-close cascade already
      // removed the registry entry.
    }
  }) as StreamEndBridge
}