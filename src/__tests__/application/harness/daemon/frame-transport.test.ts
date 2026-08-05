import { describe, it, expect } from "vitest";
import { Writable, pipeline, type TransformCallback } from "node:stream";
import {
  encodeFrame,
  FrameReader,
  CoalescingTransform,
  writeFrame,
  writeEofFrame,
} from "../../../../application/harness/daemon/frame-transport.js";
import { listen, connect, collectFrames } from "./helpers.js";

describe("FrameReader", () => {
  it("reassembles frames split across arbitrary chunk boundaries", () => {
    const reader = new FrameReader();
    const frames: Buffer[] = [];
    reader.onFrame = (p) => frames.push(p);
    const frame = encodeFrame("hello terminal");
    for (const byte of frame) reader.feed(Buffer.from([byte]));
    expect(frames).toHaveLength(1);
    expect(frames[0].toString("utf8")).toBe("hello terminal");
  });

  it("decodes multiple frames in a single chunk", () => {
    const reader = new FrameReader();
    const frames: Buffer[] = [];
    reader.onFrame = (p) => frames.push(p);
    reader.feed(Buffer.concat([encodeFrame("one"), encodeFrame("two")]));
    expect(frames.map((f) => f.toString("utf8"))).toEqual(["one", "two"]);
  });

  it("splits a payload across a header boundary", () => {
    const reader = new FrameReader();
    const frames: Buffer[] = [];
    reader.onFrame = (p) => frames.push(p);
    const frame = encodeFrame("0123456789");
    reader.feed(frame.subarray(0, 2)); // partial header
    reader.feed(frame.subarray(2)); // rest
    expect(frames.map((f) => f.toString("utf8"))).toEqual(["0123456789"]);
  });

  it("triggers onEof exactly once and stops parsing", () => {
    const reader = new FrameReader();
    let eof = 0;
    const frames: Buffer[] = [];
    reader.onFrame = (p) => frames.push(p);
    reader.onEof = () => { eof++; };
    reader.feed(Buffer.concat([encodeFrame("x"), Buffer.alloc(4), encodeFrame("ignored")]));
    expect(eof).toBe(1);
    expect(frames.map((f) => f.toString("utf8"))).toEqual(["x"]);
    expect(reader.isEof).toBe(true);
  });

  it("round-trips frames over a real socket", async () => {
    const { server, port } = await listen((sock) => {
      writeFrame(sock, "first");
      writeFrame(sock, "second");
      writeEofFrame(sock);
      sock.end();
    });
    const client = await connect(port);
    const { frames, eof, lastData } = collectFrames(client);
    await eof;
    expect(frames.map((f) => f.toString("utf8"))).toEqual(["first", "second"]);
    expect(lastData()).toBe("firstsecond");
    server.close();
  });

  it("never encodes an empty payload as the EOF frame", async () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
        chunks.push(chunk);
        cb();
      },
    });
    writeFrame(sink as any, ""); // empty → must be skipped, not encoded as EOF
    writeFrame(sink as any, "x");
    writeEofFrame(sink as any);
    sink.end();
    expect(chunks).toHaveLength(2); // empty produced no chunk; only 'x' frame + EOF
    expect(chunks[0].length).toBe(5); // 4-byte length header + 1 payload byte
    expect(chunks[0].subarray(4).toString("utf8")).toBe("x");
    expect(chunks[1].length).toBe(4); // only the real EOF marker
  });
});

describe("CoalescingTransform", () => {
  function collect(transform: CoalescingTransform): {
    frames: Buffer[];
    eof: Promise<void>;
    done: Promise<void>;
  } {
    const reader = new FrameReader();
    const frames: Buffer[] = [];
    reader.onFrame = (p) => frames.push(p);
    const eof = new Promise<void>((resolve) => { reader.onEof = () => resolve(); });
    const done = new Promise<void>((resolve, reject) => {
      const sink = new Writable({
        write(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
          reader.feed(chunk);
          cb();
        },
      });
      sink.on("error", reject);
      pipeline(transform, sink, (err) => (err ? reject(err) : resolve()));
    });
    return { frames, eof, done };
  }

  it("coalesces a burst into a single frame", async () => {
    const t = new CoalescingTransform(10);
    const { frames, done } = collect(t);
    t.write(Buffer.from("a"));
    t.write(Buffer.from("b"));
    t.write(Buffer.from("c"));
    t.end();
    await done;
    expect(frames.map((f) => f.toString("utf8"))).toEqual(["abc"]);
    expect(frames).toHaveLength(1);
  });

  it("flushes a large batch immediately (size-bound)", async () => {
    const t = new CoalescingTransform(5000, 8);
    const { frames, done } = collect(t);
    t.write(Buffer.from("aaa"));
    t.write(Buffer.from("bbbbb")); // pending = 8 → immediate flush, no wait
    expect(frames.map((f) => f.toString("utf8"))).toEqual(["aaabbbbb"]);
    t.end();
    await done;
  });

  it("emits an EOF frame on end after flushing remaining data", async () => {
    const t = new CoalescingTransform(5000);
    const { frames, eof, done } = collect(t);
    t.write(Buffer.from("tail"));
    t.end();
    await done;
    expect(frames.map((f) => f.toString("utf8"))).toEqual(["tail"]);
    await eof;
  });

  it("streams coalesced frames through pipeline to a socket", async () => {
    const { server, port } = await listen((sock) => {
      const t = new CoalescingTransform(10);
      pipeline(t, sock, () => {});
      t.write(Buffer.from("chunk1"));
      t.write(Buffer.from("chunk2"));
      t.end();
    });
    const client = await connect(port);
    const { eof, lastData } = collectFrames(client);
    await eof;
    expect(lastData()).toBe("chunk1chunk2");
    server.close();
  });

  it("clears its flush timer on destroy so pending data never late-pushes", async () => {
    const t = new CoalescingTransform(10);
    const errors: Error[] = [];
    t.on("error", (e: Error) => errors.push(e));
    t.write(Buffer.from("pending")); // arms the flush timer
    t.destroy(); // must cancel the timer, not push into a destroyed stream
    await new Promise((r) => setTimeout(r, 30)); // let the old timer window lapse
    expect(t.destroyed).toBe(true);
    expect(errors).toEqual([]);
  });
});
