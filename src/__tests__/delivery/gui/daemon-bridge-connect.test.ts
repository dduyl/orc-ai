/**
 * Diagnostic integration test: exercises the full DaemonBridge.connect() flow
 * (PipeClient.connect → attachMain → send status) WITHOUT Electron and WITHOUT
 * spawning a child process. Uses an in-process DaemonServer.
 *
 * If this test passes → the problem is in the Electron IPC delivery layer
 *   (preload/contextBridge/webContents.send timing).
 * If this test fails → the problem is in the daemon bridge connection flow
 *   and the failure message pinpoints exactly where.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonBridge } from "../../../delivery/gui/daemon-bridge.js";
import { IPC, type MainSender } from "../../../delivery/gui/ipc.js";

interface MockSenderState {
  calls: Array<{ channel: string; data: unknown }>;
}

function createMockSender(): { sender: MainSender; state: MockSenderState } {
  const state: MockSenderState = { calls: [] };
  const sender: MainSender = (channel, data) => {
    state.calls.push({ channel, data });
  };
  return { sender, state };
}

function findCall(state: MockSenderState, channel: string): { channel: string; data: unknown } | undefined {
  return state.calls.find((c) => c.channel === channel);
}

function findCalls(state: MockSenderState, channel: string): Array<{ channel: string; data: unknown }> {
  return state.calls.filter((c) => c.channel === channel);
}

let tmpDir: string;
let bridge: DaemonBridge | null = null;
let daemon: import("../../../application/harness/daemon/daemon-server.js").DaemonServer | null = null;

afterEach(async () => {
  bridge?.dispose();
  bridge = null;
  try { await daemon?.stop(); } catch { /* ignore */ }
  daemon = null;
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("DaemonBridge.connect() end-to-end (in-process daemon, no Electron)", () => {
  it("connects and delivers all critical status events to the renderer", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "orc-bridge-test-"));

    // 1. Start an in-process daemon bound to tmpDir (no pipeOverride — uses
    //    the same hash derivation the bridge's tryConnect() uses).
    const { DaemonServer } = await import("../../../application/harness/daemon/daemon-server.js");
    const { WorkflowRegistry } = await import("../../../application/planner/registry.js");

    const registry = new WorkflowRegistry({
      userDir: join(tmpDir, "workflows"),
      builtinDir: join(tmpDir, "no-builtins"),
    });
    registry.loadAll();

    daemon = new DaemonServer({
      projectDir: tmpDir,
      registry,
      spawnMain: () => ({
        onData: () => {},
        onExit: () => {},
        write: () => {},
        kill: () => {},
      }),
    });

    await daemon.start();
    console.log("[test] daemon started, control pipe:", daemon.controlPipe);

    // 2. Create the bridge with a mock sender.
    const { sender, state } = createMockSender();
    bridge = new DaemonBridge(sender);

    // 3. Connect — this should find the existing daemon via tryConnect().
    const startTime = Date.now();
    await bridge.connect(tmpDir, "opencode");
    const elapsed = Date.now() - startTime;
    console.log(`[test] bridge.connect() completed in ${elapsed}ms`);
    console.log(`[test] total IPC calls: ${state.calls.length}`);
    for (const call of state.calls) {
      console.log(`[test]   -> ${call.channel}: ${JSON.stringify(call.data).slice(0, 200)}`);
    }

    // 4. Assert critical events.

    // chat-reset: clears stale renderer state on fresh attach.
    const chatReset = findCall(state, IPC.MainToRenderer["chat-reset"]);
    expect(chatReset).toBeDefined();

    // status "spawned": THIS is what drives the GUI from "Initializing..." to connected.
    const statusCall = findCall(state, IPC.MainToRenderer.status);
    expect(statusCall).toBeDefined();
    expect(statusCall!.data).toMatchObject({
      type: "spawned",
      adapter: "opencode",
    });
    expect(["pty", "acp"]).toContain((statusCall!.data as any).mode);

    // step-activated "main": confirms switchToStep ran.
    const stepActivated = findCall(state, IPC.MainToRenderer["step-activated"]);
    expect(stepActivated).toBeDefined();
    expect(stepActivated!.data).toMatchObject({ stepId: "__main__" });

    // log: confirms attach completed.
    const logCalls = findCalls(state, IPC.MainToRenderer.log);
    expect(logCalls.length).toBeGreaterThan(0);
    const attachLog = logCalls.find((c) =>
      (c.data as any)?.text?.includes("attached to daemon main terminal"),
    );
    expect(attachLog).toBeDefined();

    // getBootLog: returns array (may be empty for in-process daemon).
    const bootLog = bridge.getBootLog();
    expect(Array.isArray(bootLog)).toBe(true);

    console.log("[test] ALL ASSERTIONS PASSED");
  }, 30_000);

  it("events arrive in correct order: chat-reset before status before step-activated", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "orc-bridge-order-"));

    const { DaemonServer } = await import("../../../application/harness/daemon/daemon-server.js");
    const { WorkflowRegistry } = await import("../../../application/planner/registry.js");

    const registry = new WorkflowRegistry({
      userDir: join(tmpDir, "workflows"),
      builtinDir: join(tmpDir, "no-builtins"),
    });
    registry.loadAll();

    daemon = new DaemonServer({
      projectDir: tmpDir,
      registry,
      spawnMain: () => ({
        onData: () => {},
        onExit: () => {},
        write: () => {},
        kill: () => {},
      }),
    });
    await daemon.start();

    const { sender, state } = createMockSender();
    bridge = new DaemonBridge(sender);
    await bridge.connect(tmpDir, "opencode");

    // Find the indices of the critical events.
    const resetIdx = state.calls.findIndex((c) => c.channel === IPC.MainToRenderer["chat-reset"]);
    const statusIdx = state.calls.findIndex((c) => c.channel === IPC.MainToRenderer.status);
    const stepIdx = state.calls.findIndex((c) => c.channel === IPC.MainToRenderer["step-activated"]);

    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(stepIdx).toBeGreaterThanOrEqual(0);

    // chat-reset must come before status (clear chat before new session).
    expect(resetIdx).toBeLessThan(statusIdx);
    // status must come before step-activated.
    expect(statusIdx).toBeLessThan(stepIdx);

    console.log("[test] ORDER ASSERTIONS PASSED: chat-reset < status < step-activated");
  }, 30_000);
});
