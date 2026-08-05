import { describe, it, expect } from "vitest";
import { TerminalStore } from "../../../../application/harness/daemon/terminal-store.js";
import { listen, connect, collectFrames, fakePty, flushUntil } from "./helpers.js";

describe("TerminalStore", () => {
  it("feeds step pty bytes into the run terminal", async () => {
    const store = new TerminalStore();
    const run = store.ensure("r1", { coalesceMs: 5 });
    const { pty, emitData } = fakePty();
    run.feedPty("s1", pty);
    emitData("hello");
    await run.waitParsed();
    expect(run.serialize()).toContain("hello");
    store.delete("r1");
  });

  it("prepends a step marker on a step's first byte", async () => {
    const store = new TerminalStore();
    const run = store.ensure("r1", { coalesceMs: 5 });
    const { pty, emitData } = fakePty();
    run.feedPty("codegen", pty);
    emitData("x");
    await run.waitParsed();
    expect(run.serialize()).toContain("[step: codegen]");
    store.delete("r1");
  });

  it("writes a distinct redo marker when the same step is re-dispatched", async () => {
    const store = new TerminalStore();
    const run = store.ensure("r1", { coalesceMs: 5 });
    const first = fakePty();
    run.feedPty("gate", first.pty);
    first.emitData("attempt-1");
    await run.waitParsed();
    const second = fakePty();
    run.feedPty("gate", second.pty);
    second.emitData("attempt-2");
    await run.waitParsed();
    const screen = run.serialize();
    expect(screen).toContain("[step: gate]");
    expect(screen).toContain("[step: gate (redo 1)]");
    store.delete("r1");
  });

  it("ignores late pty data after dispose", async () => {
    const store = new TerminalStore();
    const run = store.ensure("r1", { coalesceMs: 5 });
    const { pty, emitData } = fakePty();
    run.feedPty("s1", pty);
    emitData("early");
    await run.waitParsed();
    run.dispose();
    expect(() => emitData("late")).not.toThrow();
    const run2 = store.ensure("r2", { coalesceMs: 5 });
    const after = fakePty();
    run2.feedPty("s2", after.pty);
    after.emitData("after");
    await run2.waitParsed();
    expect(run2.serialize()).toContain("after");
    store.delete("r2");
  });

  it("streams live frames to an attached client and EOF on complete", async () => {
    const store = new TerminalStore();
    const run = store.ensure("r1", { coalesceMs: 5 });
    const { server, port } = await listen((sock) => { void store.attach("r1", sock); });
    const client = await connect(port);
    const { frames, eof, lastData } = collectFrames(client);
    const { pty, emitData } = fakePty();
    run.feedPty("s1", pty);
    emitData("LIVE_OUTPUT");
    await flushUntil(() => lastData().includes("LIVE_OUTPUT"));
    await run.complete();
    await eof;
    expect(frames.length).toBeGreaterThan(0);
    server.close();
    store.delete("r1");
  });

  it("replays the accumulated screen to a late-attaching client after complete", async () => {
    const store = new TerminalStore();
    const run = store.ensure("r1", { coalesceMs: 5 });
    const { pty, emitData } = fakePty();
    run.feedPty("s1", pty);
    emitData("FINISHED_SCREEN");
    await run.complete();
    const { server, port } = await listen((sock) => { void store.attach("r1", sock); });
    const client = await connect(port);
    const { eof, lastData } = collectFrames(client);
    await eof;
    expect(lastData()).toContain("FINISHED_SCREEN");
    server.close();
    store.delete("r1");
  });

  it("replays then streams live frames to a client attached mid-run", async () => {
    const store = new TerminalStore();
    const run = store.ensure("r1", { coalesceMs: 5 });
    const { pty, emitData } = fakePty();
    run.feedPty("s1", pty);
    emitData("BEFORE_ATTACH");
    await run.waitParsed();
    const { server, port } = await listen((sock) => { void store.attach("r1", sock); });
    const client = await connect(port);
    const { eof, lastData } = collectFrames(client);
    await flushUntil(() => lastData().includes("BEFORE_ATTACH"));
    emitData("AFTER_ATTACH");
    await flushUntil(() => lastData().includes("AFTER_ATTACH"));
    await run.complete();
    await eof;
    server.close();
    store.delete("r1");
  });

  it("keeps serving other clients after a live client dies mid-stream", async () => {
    const store = new TerminalStore();
    const run = store.ensure("r1", { coalesceMs: 5 });
    const { server, port } = await listen((sock) => { void store.attach("r1", sock); });
    const client = await connect(port);
    const { lastData } = collectFrames(client);
    const { pty, emitData } = fakePty();
    run.feedPty("s1", pty);
    emitData("OUT");
    await flushUntil(() => lastData().includes("OUT"));
    client.destroy(); // abrupt client teardown → server-side 'error'/'close'
    await new Promise((r) => setTimeout(r, 20));
    const client2 = await connect(port);
    const { eof, lastData: lastData2 } = collectFrames(client2);
    emitData("OUT2");
    await flushUntil(() => lastData2().includes("OUT2"));
    await run.complete();
    await eof;
    server.close();
    store.delete("r1");
  });

  it("cleans up run terminals on delete", async () => {
    const store = new TerminalStore();
    store.ensure("r1");
    store.ensure("r2");
    expect(store.size).toBe(2);
    store.delete("r1");
    expect(store.size).toBe(1);
    expect(store.get("r1")).toBeUndefined();
  });
});
