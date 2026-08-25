import { describe, it, expect, vi } from "vitest";
import { DaemonBridge } from "../../../delivery/gui/daemon-bridge.js";
import { IPC, type MainSender } from "../../../delivery/gui/ipc.js";
import type { ProgressEvent } from "../../../application/harness/orchestrator/index.js";
import { loadYamlFile } from "../../../application/planner/workflow-parser.js";
import { join } from "node:path";

type Sent = Array<{ channel: string; data: unknown }>;

function createBridge(): { bridge: DaemonBridge; sent: Sent; last: (ch: string) => any } {
  const sent: Sent = [];
  const sender: MainSender = (channel, data) => {
    sent.push({ channel: channel as string, data });
  };
  const bridge = new DaemonBridge(sender);
  return {
    bridge,
    sent,
    last: (ch: string) => [...sent].reverse().find(s => s.channel === ch)?.data,
  };
}

/** Seed the private activeWorkflow via a started run through the real builtin YAML. */
async function seedWorkflow(bridge: DaemonBridge): Promise<void> {
  const def = loadYamlFile(join("src", "workflows", "feat-impl-builtin.yaml"));
  expect(def).not.toBeNull();
  // startWorkflow requires a client connection; instead drive the definition
  // in through adoptRunDefinition's code path by calling the private method
  // is overkill — use onProgress with a preceding workflow-started equivalent.
  // The bridge caches definitions only from its own start path, so tests here
  // push events after simulating that cache via bracket access.
  (bridge as unknown as { activeWorkflow: unknown }).activeWorkflow = def;
}

function stepStart(runId: string, stepId: string, agent?: string): ProgressEvent {
  return { type: "step_start", runId, stepId, agent };
}

function stepComplete(runId: string, stepId: string, status: string, error?: string): ProgressEvent {
  return { type: "step_complete", runId, stepId, status, error };
}

describe("daemon bridge signal derivation", () => {
  it("emits step-context on step_start with definition context/emits", async () => {
    const { bridge, last } = createBridge();
    await seedWorkflow(bridge);
    bridge["onProgress"](stepStart("run-1", "code", "codegen"));
    const ctx = last(IPC.MainToRenderer["step-context"]);
    expect(ctx).toEqual({
      stepId: "code",
      agent: "codegen",
      context: ["spec", "architecture"],
      emits: ["sig_done"],
    });
  });

  it("emits gate-result + signal-emitted for a passing script step", async () => {
    const { bridge, last } = createBridge();
    await seedWorkflow(bridge);
    bridge["onProgress"](stepComplete("run-1", "validate", "completed"));
    expect(last(IPC.MainToRenderer["gate-result"])).toEqual({
      stepId: "validate",
      gate: 'cmd "validate"',
      exitCode: 0,
      output: "",
    });
    expect(last(IPC.MainToRenderer["signal-emitted"])).toMatchObject({
      stepId: "validate",
      signal: "sig_pass",
    });
  });

  it("emits failing gate signal for script failure and matches redo edge", async () => {
    const { bridge, sent, last } = createBridge();
    await seedWorkflow(bridge);
    bridge["onProgress"](stepComplete("run-1", "validate", "failed", "tests broke"));
    expect(last(IPC.MainToRenderer["gate-result"])).toMatchObject({ exitCode: 1, output: "tests broke" });
    expect(last(IPC.MainToRenderer["signal-emitted"])).toMatchObject({ signal: "sig_fail" });
    const edges = sent.filter(s => s.channel === IPC.MainToRenderer["edge-matched"]).map(s => s.data);
    // validate.sig_fail consumers: code (redo), test (any)
    expect(edges).toContainEqual({ fromStep: "validate", signal: "sig_fail", toStep: "code", timestamp: expect.any(Number) });
  });

  it("emits loop-detected when the same step restarts within one run", async () => {
    const { bridge, last } = createBridge();
    await seedWorkflow(bridge);
    bridge["onProgress"](stepStart("run-1", "code"));
    bridge["onProgress"](stepStart("run-1", "code")); // second start → iteration 2
    expect(last(IPC.MainToRenderer["loop-detected"])).toMatchObject({
      stepId: "code",
      iteration: 2,
    });
  });

  it("attributes loop fromSignal to the last inbound matched signal", async () => {
    const { bridge, last } = createBridge();
    await seedWorkflow(bridge);
    bridge["onProgress"](stepComplete("run-1", "validate", "failed")); // validate.sig_fail -> code
    bridge["onProgress"](stepStart("run-1", "code"));
    bridge["onProgress"](stepStart("run-1", "code"));
    expect(last(IPC.MainToRenderer["loop-detected"])).toMatchObject({
      stepId: "code",
      fromSignal: "sig_fail",
    });
  });

  it("never emits stream-event anymore", async () => {
    const { bridge, sent } = createBridge();
    await seedWorkflow(bridge);
    bridge["onProgress"](stepStart("run-1", "spec"));
    bridge["onProgress"](stepComplete("run-1", "spec", "completed"));
    expect(sent.filter(s => s.channel === "stream-event")).toHaveLength(0);
  });

  it("forgets per-run loop state on completion so iterations restart cleanly", async () => {
    const { bridge, sent } = createBridge();
    await seedWorkflow(bridge);
    bridge["onProgress"](stepStart("run-1", "code"));
    bridge["onProgress"](stepStart("run-1", "code"));
    const loopsBefore = sent.filter(s => s.channel === IPC.MainToRenderer["loop-detected"]).length;
    expect(loopsBefore).toBe(1);
    bridge["forgetRunState"]("run-1");
    bridge["onProgress"](stepStart("run-2", "code"));
    const loopsAfter = sent.filter(s => s.channel === IPC.MainToRenderer["loop-detected"]).length;
    expect(loopsAfter).toBe(1); // fresh run starts at iteration 1 → no new loop
  });

  it("skips signal derivation for multi-emit agent steps (ambiguous)", async () => {
    const { bridge, sent } = createBridge();
    await seedWorkflow(bridge);
    bridge["onProgress"](stepComplete("run-1", "review_spec", "completed"));
    expect(sent.filter(s => s.channel === IPC.MainToRenderer["signal-emitted"])).toHaveLength(0);
  });
});
