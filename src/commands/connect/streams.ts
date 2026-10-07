import { encodeRpc } from './codec.js'
import { event } from './rpc.js'

export type StreamDirection = 'incoming' | 'outgoing'

export type StreamKind = 'writeFile' | 'readFile'

export interface OpenStream {
  direction: StreamDirection
  kind: StreamKind
  /** Bytes observed so far */
  bytes: number
  closed: Promise<void>

  resolveClosed: () => void
  rejectClosed: (err: Error) => void
  onClose?: (bytes: number, err?: Error) => void
}

export class StreamRegistry {
  private readonly byId = new Map<string, OpenStream>()
  private readonly writers = new Map<string, WritableStreamDefaultWriter>()

  open(opts: {
    streamId: string
    direction: StreamDirection
    kind: StreamKind
    onClose?: (bytes: number, err?: Error) => void
  }): OpenStream {
    let resolveClosed!: () => void
    let rejectClosed!: (err: Error) => void
    const closed = new Promise<void>((res, rej) => {
      resolveClosed = () => {
        res(undefined)
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
      resolveClosed() {
        resolveClosed()
      },
      rejectClosed(err: Error) {
        rejectClosed(err)
      },
      onClose: opts.onClose,
    }
    this.byId.set(opts.streamId, record)
    return record
  }

  attachWriter(streamId: string, writer: WritableStreamDefaultWriter): void {
    if (!this.writers.has(streamId)) {
      this.writers.set(streamId, writer)
    }
  }

  writer(streamId: string): WritableStreamDefaultWriter | undefined {
    return this.writers.get(streamId)
  }

  detachWriter(streamId: string): void {
    this.writers.delete(streamId)
  }

  get(streamId: string): OpenStream | undefined {
    return this.byId.get(streamId)
  }

  close(streamId: string, finalBytes: number, err?: Error): void {
    const record = this.byId.get(streamId)
    if (!record) return
    this.byId.delete(streamId)
    const writer = this.writers.get(streamId)
    if (writer) {
      this.writers.delete(streamId)
      const writerDone = writer.close().catch(() => undefined)
      if (err) {
        record.onClose?.(finalBytes, err)
      } else {
        void writerDone.then(() => record.onClose?.(finalBytes, undefined))
      }
    } else {
      record.onClose?.(finalBytes, err)
    }
    if (err) {
      record.rejectClosed(err)
      return
    }
    record.resolveClosed()
  }

  closeAll(err: Error): void {
    for (const [id, record] of this.byId) {
      record.onClose?.(0, err)
      record.rejectClosed(err)
      this.byId.delete(id)
    }
    for (const id of this.writers.keys()) {
      const writer = this.writers.get(id)
      try { writer?.close().catch(() => undefined) } catch { /* ignore */ }
      this.writers.delete(id)
    }
  }

  size(): number {
    return this.byId.size
  }
}

export interface StreamEndBridge {
  (bytes: number): void
  (bytes: number, err: Error): void
}

export function makeStreamEndBridge(
  ws: { send(data: Uint8Array): void },
  streamId: string,
): StreamEndBridge {
  return ((bytes: number, err?: Error) => {
    try {
      if (err) {
        ws.send(
          encodeRpc(
            event('streamError', {
              streamId,
              code: 0,
              message: err.message,
            }),
          ),
        )
      } else {
        ws.send(encodeRpc(event('streamEnd', { streamId, bytes })))
      }
    } catch {}
  }) as StreamEndBridge
}