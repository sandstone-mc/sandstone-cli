/**
 * Per-WS stream registry.
 *
 * Tracks half-duplex file transfers between the WS peer and the
 * host's file system. Each open stream has a 16-byte id (`streamId`)
 * prepended to every binary chunk frame so the receiver can
 * demultiplex chunks to the right handler.
 *
 * Two stream directions:
 *
 *   - **incoming**: chunks arrive from the WS peer. Used by
 *     server-side `writeFile` (host's write stream) and client-side
 *     `readFile` (host's read stream on the consumer side, but
 *     conceptually incoming because the WS pushes chunks TO us).
 *
 *   - **outgoing**: chunks leave our process to the WS peer. Used
 *     by server-side `readFile` (chunks leave the host's read
 *     stream and travel to the client) and client-side `writeFile`
 *     (chunks leave the consumer's source and travel to the server).
 *
 * Lifecycle:
 *   1. Open stream (host's WritableStream or ReadableStream is created).
 *      The caller passes an {@link OpenStream.onClose} hook to bridge
 *      close events back to the WS transport — typically a closure
 *      that fans a `streamEnd` envelope to the peer. Fires for every
 *      close path (success, error, session-close) so callers never
 *      have to remember to send the envelope themselves.
 *   2. Chunks flow via binary WS frames, tagged with streamId.
 *   3. Either side closes (server: source ends / sink `.close()`;
 *      client: `streamEnd` envelope) → registry finalises the
 *      `closed` promise, fires `onClose(bytes, err?)`, removes the
 *      entry.
 *
 * The registry does NOT enforce backpressure — that's the WS's job
 * for outgoing chunks and the web stream's `getReader().read()`
 * for incoming. It just tracks state.
 */

export type StreamDirection = 'incoming' | 'outgoing'

/** What the underlying stream represents. */
export type StreamKind = 'writeFile' | 'readFile'

export interface OpenStream {
  direction: StreamDirection
  kind: StreamKind
  /** Bytes observed so far (write or read, depending on direction). */
  bytes: number
  /**
   * Resolves when the stream is closed (cleanly via streamEnd OR
   * abandoned via closeAll). The RPC handler awaits this before
   * resolving the originating readFile/writeFile call.
   */
  closed: Promise<void>
  /** Fulfilled with the final byte count when the stream closes. */
  resolveClosed: (bytes: number) => void
  /** Reject the originating RPC if the stream is abandoned. */
  rejectClosed: (err: Error) => void
  /**
   * Bridge from registry close events back to the WS transport.
   * Fires once per stream, after the entry is removed from byId,
   * for every close path (success, error, session-close). Receives
   * the final byte count and an optional error. The caller-provided
   * implementation is responsible for whatever wire-level cleanup
   * makes sense — typically fanning a `streamEnd` envelope to the
   * peer on the success path and skipping the send on error
   * (session-close will yank the transport anyway).
   */
  onClose?: (bytes: number, err?: Error) => void
}

export class StreamRegistry {
  private readonly byId = new Map<string, OpenStream>()
  /**
   * Per-stream writer for server-side `writeFile` streams. The
   * server's binary-frame handler looks up the writer by streamId
   * and writes each chunk directly. Stored separately from the
   * `OpenStream` record because the writer isn't needed by the
   * RPC handler — only by the WS frame dispatcher.
   */
  private readonly writers = new Map<string, WritableStreamDefaultWriter>()

  /**
   * Register a new stream. Returns the open record so the caller can
   * stash a reference (e.g. on the dispatch context).
   *
   * `onClose` is the bridge from registry close events back to the
   * WS transport. Fires once per stream — on success, on error,
   * and on session-close. The caller should use it to send the
   * matching `streamEnd` envelope so the peer's `result.done`
   * settles, instead of duplicating that logic at every call site.
   */
  open(opts: {
    streamId: string
    direction: StreamDirection
    kind: StreamKind
    onClose?: (bytes: number, err?: Error) => void
  }): OpenStream {
    let resolveClosed!: (bytes: number) => void
    let rejectClosed!: (err: Error) => void
    const closed = new Promise<void>((res, rej) => {
      resolveClosed = (bytes: number) => {
        res(undefined)
        // Bytes count is surfaced via the wire envelope (server-side
        // callback fires `onClose(bytes)` → envelope sends bytes),
        // not via this resolved promise. Swallow the unused param.
        void bytes
      }
      rejectClosed = (err: Error) => {
        rej(err)
      }
    })
    const record: OpenStream = {
      direction: opts.direction,
      kind: opts.kind,
      bytes: 0,
      closed,
      resolveClosed(bytes: number) {
        resolveClosed(bytes)
      },
      rejectClosed(err: Error) {
        rejectClosed(err)
      },
      onClose: opts.onClose,
    }
    this.byId.set(opts.streamId, record)
    return record
  }

  /**
   * Attach a `WritableStreamDefaultWriter` for a server-side
   * `writeFile` stream. Subsequent binary-frame chunks for that
   * streamId are written via this writer. Idempotent — calling twice
   * is a no-op (the existing writer is kept).
   */
  attachWriter(streamId: string, writer: WritableStreamDefaultWriter): void {
    if (!this.writers.has(streamId)) {
      this.writers.set(streamId, writer)
    }
  }

  /** Look up the writer for an incoming chunk. */
  writer(streamId: string): WritableStreamDefaultWriter | undefined {
    return this.writers.get(streamId)
  }

  /** Remove the writer without touching the OpenStream record. */
  detachWriter(streamId: string): void {
    this.writers.delete(streamId)
  }

  /** Look up an open stream. Returns undefined if it has been closed. */
  get(streamId: string): OpenStream | undefined {
    return this.byId.get(streamId)
  }

  /**
   * Close + remove a stream. Idempotent — calling twice on the same
   * id is a no-op. Finalises the `closed` promise so the awaiting
   * RPC handler can resolve its response. Also releases the
   * attached writer if one is registered, and fires `onClose(bytes,
   * err?)` once for the wire-transport bridge (success path).
   */
  close(streamId: string, finalBytes: number, err?: Error): void {
    const record = this.byId.get(streamId)
    if (!record) return
    this.byId.delete(streamId)
    const writer = this.writers.get(streamId)
    if (writer) {
      this.writers.delete(streamId)
      // `close()` the writer — finalises the host's WritableStream.
      // Errors here are surfaced via the writer's already-failed
      // promise, not via this path.
      try { writer.close().catch(() => {}) } catch { /* ignore */ }
    }
    // Fire the wire-transport bridge BEFORE settling the closed
    // promise so the caller can rely on onClose having completed
    // by the time any awaiter resumes. Bridge errors (e.g. WS
    // already closed) are swallowed inside the caller-provided
    // callback.
    record.onClose?.(finalBytes, err)
    if (err) {
      record.rejectClosed(err)
      return
    }
    record.resolveClosed(finalBytes)
  }

  /**
   * Force-close every open stream. Used on daemon shutdown. Fires
   * `onClose(0, err)` for each entry so the transport bridge has a
   * chance to react (typically: skip the send because the WS is
   * dying anyway).
   */
  closeAll(err: Error): void {
    for (const [id, record] of this.byId) {
      record.onClose?.(0, err)
      record.rejectClosed(err)
      this.byId.delete(id)
    }
    for (const id of this.writers.keys()) {
      const writer = this.writers.get(id)
      try { writer?.close().catch(() => {}) } catch { /* ignore */ }
      this.writers.delete(id)
    }
  }

  /** How many streams are currently open. Diagnostic. */
  size(): number {
    return this.byId.size
  }
}