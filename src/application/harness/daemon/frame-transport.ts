import { Transform } from "node:stream";
import type { Socket } from "node:net";

/**
 * Terminal byte channel framing (ADR-025 Phase C locked design #6 + Phase D D-4).
 *
 * Data frames are length-prefixed and carry a step identifier so a client can
 * demux by origin instead of parsing text markers:
 *
 *   `[uint32 LE totalLen][uint16 LE stepIdLen][stepId UTF-8][payload]`
 *
 * `totalLen` is the number of bytes following the length field
 * (2 + stepIdLen + payloadLen). A zero-length frame (`uint32 0`) is the EOF
 * marker. No JSON escaping — PTY bytes flow through untouched, and the reader
 * is ~15 lines.
 *
 * Reserved step ids: `SCREEN_STEP_ID` = the late-attach screen-snapshot frame
 * (whole-run replay, not attributed to any step); `MAIN_STEP_ID` = the
 * daemon-owned main terminal (Phase D D-3).
 *
 * The writer is fire-and-forget: `writeFrame` never backpressures the caller.
 * Backpressure for a slow consumer is provided upstream by the coalescing
 * `CoalescingTransform` (bounded batch window), which is piped into the
 * socket so Node's flow-control applies.
 */

export const EOF_FRAME_LENGTH = 0;

/** stepId for the late-attach screen-snapshot frame (whole-run replay). */
export const SCREEN_STEP_ID = "__screen__";
/** stepId for the daemon-owned main terminal (Phase D D-3). */
export const MAIN_STEP_ID = "__main__";

/** Max bytes buffered before a coalesced batch is flushed as one frame. */
export const DEFAULT_MAX_FRAME_BYTES = 4096;
/** Max time a batch waits before being flushed (coalescing window). */
export const DEFAULT_FLUSH_MS = 16;

export function encodeFrame(stepId: string, payload: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const step = Buffer.from(stepId, "utf8");
  const totalLen = 2 + step.length + buf.length;
  const header = Buffer.alloc(6);
  header.writeUInt32LE(totalLen, 0);
  header.writeUInt16LE(step.length, 4);
  return Buffer.concat([header, step, buf]);
}

export function writeFrame(sock: Socket, stepId: string, payload: Buffer | string): void {
  // A zero-length frame IS the EOF marker (protocol), so an empty payload must
  // never be encoded as one. An empty write carries no information anyway.
  if ((Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload, "utf8")) === 0) return;
  sock.write(encodeFrame(stepId, payload));
}

export function writeEofFrame(sock: Socket): void {
  sock.write(Buffer.alloc(4));
}

/** A decoded terminal frame: payload plus the step that produced it. */
export interface TerminalFrame {
  stepId: string;
  payload: Buffer;
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
  onFrame?: (frame: TerminalFrame) => void;
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
      const totalLen = this.buf.readUInt32LE(this.offset);
      if (totalLen === EOF_FRAME_LENGTH) {
        this.eof = true;
        this.onEof?.();
        return;
      }
      const need = 4 + totalLen;
      if (this.buf.length - this.offset < need) {
        if (this.chunks.length === 0) return;
        this.pull(need);
        continue;
      }
      const stepLen = this.buf.readUInt16LE(this.offset + 4);
      const stepId = this.buf.toString("utf8", this.offset + 6, this.offset + 6 + stepLen);
      const payload = this.buf.subarray(this.offset + 6 + stepLen, this.offset + need);
      this.offset += need;
      this.onFrame?.({ stepId, payload });
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

/** A coalesced batch entry: bytes grouped by step, in first-arrival order. */
interface PendingEntry {
  stepId: string;
  bufs: Buffer[];
}

/**
 * Batching Transform for the terminal byte channel. Accepts `{ stepId, data }`
 * chunks (writableObjectMode) and flushes them as length-prefixed frames,
 * coalescing contiguous same-step runs so a batch never mixes steps. Flushes
 * when the pending buffer reaches `maxBytes` (immediate) or after `flushMs` of
 * quiet time; emits the EOF frame on end. Piping this into the client socket
 * gives coalescing + backpressure for free (ADR locked design #6/#8).
 */
export class CoalescingTransform extends Transform {
  private pending: PendingEntry[] = [];
  private pendingBytes = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly flushMs: number = DEFAULT_FLUSH_MS,
    private readonly maxBytes: number = DEFAULT_MAX_FRAME_BYTES,
  ) {
    super({ writableObjectMode: true });
  }

  override _transform(chunk: { stepId: string; data: Buffer }, _enc: BufferEncoding, cb: () => void): void {
    const last = this.pending[this.pending.length - 1];
    if (last && last.stepId === chunk.stepId) {
      last.bufs.push(chunk.data);
    } else {
      this.pending.push({ stepId: chunk.stepId, bufs: [chunk.data] });
    }
    this.pendingBytes += chunk.data.length;
    if (this.pendingBytes >= this.maxBytes) {
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

  /** Flush any pending batches immediately (for deterministic tests / shutdown). */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    for (const entry of this.pending) {
      this.push(encodeFrame(entry.stepId, Buffer.concat(entry.bufs)));
    }
    this.pending = [];
    this.pendingBytes = 0;
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
