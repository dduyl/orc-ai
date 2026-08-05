import { Transform } from "node:stream";
import type { Socket } from "node:net";

/**
 * Terminal byte channel framing (ADR-025 Phase C, locked design #6).
 *
 * Frames are raw length-prefixed: `[uint32 LE payloadLength][payload]`. A
 * zero-length frame is the EOF marker. No JSON escaping — PTY bytes flow
 * through untouched, and the reader is ~15 lines.
 *
 * The writer is fire-and-forget: `writeFrame` never backpressures the caller.
 * Backpressure for a slow consumer is provided upstream by the coalescing
 * `CoalescingTransform` (bounded batch window), which is piped into the
 * socket so Node's flow-control applies.
 */

export const EOF_FRAME_LENGTH = 0;

/** Max bytes buffered before a coalesced batch is flushed as one frame. */
export const DEFAULT_MAX_FRAME_BYTES = 4096;
/** Max time a batch waits before being flushed (coalescing window). */
export const DEFAULT_FLUSH_MS = 16;

export function encodeFrame(payload: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  return Buffer.concat([header, buf]);
}

export function writeFrame(sock: Socket, payload: Buffer | string): void {
  // A zero-length frame IS the EOF marker (protocol), so an empty payload must
  // never be encoded as one. An empty write carries no information anyway.
  if ((Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload, "utf8")) === 0) return;
  sock.write(encodeFrame(payload));
}

export function writeEofFrame(sock: Socket): void {
  sock.write(Buffer.alloc(4));
}

/**
 * Incremental length-prefixed frame decoder. Feed it raw socket bytes (any
 * chunking); it reassembles headers + payloads across chunks and invokes the
 * callbacks. A zero-length frame triggers `onEof` exactly once and stops
 * parsing.
 */
export class FrameReader {
  /** Not-yet-materialized input chunks, so per-feed concat is avoided. */
  private chunks: Buffer[] = [];
  /** Working buffer of assembled bytes; `offset` is the next unparsed byte. */
  private buf: Buffer = Buffer.alloc(0);
  private offset = 0;
  private eof = false;
  onFrame?: (payload: Buffer) => void;
  onEof?: () => void;
  onError?: (err: Error) => void;

  feed(chunk: Buffer): void {
    if (this.eof) return;
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.parse();
  }

  /**
   * Decode every complete frame available. Bytes are copied into the working
   * buffer only when a header or payload boundary actually needs them, so a
   * stream of many small chunks never re-concatenates the whole backlog (the
   * previous per-feed `Buffer.concat` was quadratic on byte-at-a-time input).
   */
  private parse(): void {
    while (!this.eof) {
      if (this.buf.length - this.offset < 4) {
        if (this.chunks.length === 0) return;
        this.pull(4);
        continue;
      }
      const len = this.buf.readUInt32LE(this.offset);
      const need = 4 + len;
      if (this.buf.length - this.offset < need) {
        if (this.chunks.length === 0) return;
        this.pull(need);
        continue;
      }
      const payload = this.buf.subarray(this.offset + 4, this.offset + need);
      this.offset += need;
      if (len === EOF_FRAME_LENGTH) {
        this.eof = true;
        this.onEof?.();
        return;
      }
      this.onFrame?.(payload);
    }
  }

  /** Move queued chunks into the working buffer until it holds `need` unparsed bytes. */
  private pull(need: number): void {
    if (this.offset > 0) {
      this.buf = this.buf.subarray(this.offset);
      this.offset = 0;
    }
    while (this.buf.length < need && this.chunks.length > 0) {
      this.buf = Buffer.concat([this.buf, this.chunks.shift()!]);
    }
  }

  get isEof(): boolean {
    return this.eof;
  }
}

/**
 * Batching Transform for the terminal byte channel. Accumulates chunks and
 * flushes them as a single length-prefixed frame either when the pending
 * buffer reaches `maxBytes` (immediate) or after `flushMs` of quiet time.
 * Emits the EOF frame on end. Piping this into the client socket gives
 * coalescing + backpressure for free (ADR locked design #6/#8).
 */
export class CoalescingTransform extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly flushMs: number = DEFAULT_FLUSH_MS,
    private readonly maxBytes: number = DEFAULT_MAX_FRAME_BYTES,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    if (this.pending.length >= this.maxBytes) {
      this.flushNow();
    } else {
      this.schedule();
    }
    cb();
  }

  override _flush(cb: () => void): void {
    this.flushNow();
    this.push(Buffer.alloc(4)); // EOF frame
    cb();
  }

  /**
   * A destroyed stream (e.g. a terminal-pipe client that disconnected) must not
   * keep its coalescing timer alive: a later flushNow would push into a
   * destroyed stream. Pending data is intentionally dropped — the consumer left.
   */
  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    cb(err);
  }

  /** Flush any pending batch immediately (for deterministic tests / shutdown). */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    this.push(encodeFrame(this.pending));
    this.pending = Buffer.alloc(0);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushNow();
    }, this.flushMs);
    this.timer.unref();
  }
}
