import { describe, it, expect, vi, beforeEach } from "vitest";
import { DaemonBridge } from "../../../delivery/gui/daemon-bridge.js";
import { IPC } from "../../../delivery/gui/ipc.js";
import type { MainSender } from "../../../delivery/gui/ipc.js";
import type { ProgressEvent } from "../../../application/harness/orchestrator/index.js";
import type { WorkflowCompleteInfo } from "../../../application/harness/daemon/rpc-protocol.js";

function createMockBridge(): DaemonBridge {
  const sentEvents: Array<{ channel: string; data: unknown }> = [];
  const mockSender: MainSender = (channel, data) => {
    sentEvents.push({ channel, data });
  };
  const bridge = new DaemonBridge(mockSender);
  return bridge as DaemonBridge & { sentEvents: typeof sentEvents };
}

describe("DaemonBridge - signal event parsing (deferred)", () => {
  let bridge: ReturnType<typeof createMockBridge>;

  beforeEach(() => {
    bridge = createMockBridge();
  });

  it("defines workflow-started channel in IPC", () => {
    expect(IPC.MainToRenderer["workflow-started"]).toBe("workflow-started");
  });

  it("defines workflow-complete channel in IPC", () => {
    expect(IPC.MainToRenderer["workflow-complete"]).toBe("workflow-complete");
  });

  it("defines signal-emitted channel in IPC", () => {
    expect(IPC.MainToRenderer["signal-emitted"]).toBe("signal-emitted");
  });

  it("defines edge-matched channel in IPC", () => {
    expect(IPC.MainToRenderer["edge-matched"]).toBe("edge-matched");
  });

  it("defines gate-result channel in IPC", () => {
    expect(IPC.MainToRenderer["gate-result"]).toBe("gate-result");
  });

  it("defines loop-detected channel in IPC", () => {
    expect(IPC.MainToRenderer["loop-detected"]).toBe("loop-detected");
  });

  it("defines step-context channel in IPC", () => {
    expect(IPC.MainToRenderer["step-context"]).toBe("step-context");
  });

  it("defines start-workflow invoke in IPC", () => {
    expect(IPC.RendererToMainInvoke["start-workflow"]).toBe("start-workflow");
  });

  it("defines get-workflow-graph invoke in IPC", () => {
    expect(IPC.RendererToMainInvoke["get-workflow-graph"]).toBe("get-workflow-graph");
  });

  it("defines get-signal-trace invoke in IPC", () => {
    expect(IPC.RendererToMainInvoke["get-signal-trace"]).toBe("get-signal-trace");
  });

  it("defines list-workflows invoke in IPC", () => {
    expect(IPC.RendererToMainInvoke["list-workflows"]).toBe("list-workflows");
  });

  it("ProgressEvent type has required fields for future signal parsing", () => {
    const stepStartEvent: ProgressEvent = {
      type: "step_start",
      runId: "run-123",
      stepId: "spec",
      agent: "requirement_analyst",
      task: "Analyze requirements",
    };
    expect(stepStartEvent.type).toBe("step_start");
    expect(stepStartEvent.stepId).toBe("spec");
    expect(stepStartEvent.agent).toBe("requirement_analyst");

    const stepCompleteEvent: ProgressEvent = {
      type: "step_complete",
      runId: "run-123",
      stepId: "spec",
      status: "completed",
      duration: 3,
    };
    expect(stepCompleteEvent.type).toBe("step_complete");
    expect(stepCompleteEvent.status).toBe("completed");

    const workflowCompleteEvent: ProgressEvent = {
      type: "workflow_complete",
      runId: "run-123",
      report: {
        workflowId: "feature_implementation_builtin",
        source: "registered",
        outcomes: [],
        totalSteps: 3,
        completed: 3,
        failed: 0,
        paused: 0,
      },
    };
    expect(workflowCompleteEvent.type).toBe("workflow_complete");
    expect(workflowCompleteEvent.report?.workflowId).toBe("feature_implementation_builtin");
  });

  it("WorkflowCompleteInfo has status field", () => {
    const info: WorkflowCompleteInfo = {
      runId: "run-123",
      status: "completed",
    };
    expect(info.status).toBe("completed");

    const failedInfo: WorkflowCompleteInfo = {
      runId: "run-123",
      status: "failed",
    };
    expect(failedInfo.status).toBe("failed");
  });
});