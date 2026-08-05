import * as net from "node:net";
import { FrameReader } from "../../../../application/harness/daemon/frame-transport.js";
import type { PtyLike } from "../../../../application/harness/daemon/terminal-store.js";

/** Create a localhost server; resolve once it is listening. */
export async function listen(onConn: (sock: net.Socket) => void): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer(onConn);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

export function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => resolve(sock));
    sock.on("error", reject);
  });
}

/** Wire a socket into a FrameReader; tracks decoded frames + EOF. */
export function collectFrames(sock: net.Socket): {
  frames: Buffer[];
  eof: Promise<void>;
  lastData: () => string;
} {
  const reader = new FrameReader();
  const frames: Buffer[] = [];
  reader.onFrame = (p) => frames.push(p);
  const eof = new Promise<void>((resolve) => { reader.onEof = () => resolve(); });
  sock.on("data", (c) => reader.feed(c));
  return {
    frames,
    eof,
    lastData: () => frames.map((f) => f.toString("utf8")).join(""),
  };
}

export async function flushUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Injectable fake PTY matching the PtyLike subset. */
export function fakePty(): {
  pty: PtyLike;
  emitData: (d: string) => void;
  emitExit: (code?: number) => void;
} {
  let onData: ((d: string) => void) | undefined;
  let onExit: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  return {
    pty: {
      onData: (cb: (d: string) => void) => { onData = cb; },
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { onExit = cb; },
      kill: () => {},
    },
    emitData: (d: string) => { onData?.(d); },
    emitExit: (code = 0) => { onExit?.({ exitCode: code }); },
  };
}
