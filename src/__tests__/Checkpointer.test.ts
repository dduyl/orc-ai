import { describe, it, expect, beforeEach } from "vitest";
import { Checkpointer } from "../harness/Checkpointer.js";
import * as path from "node:path";
import * as os from "node:os";

function tmpDb() {
  return path.join(os.tmpdir(), `orc-checkpoint-${Date.now()}.sqlite`);
}

describe("Checkpointer", () => {
  let dbPath: string;
  let cp: Checkpointer;

  beforeEach(() => {
    dbPath = tmpDb();
    cp = new Checkpointer(dbPath);
  });

  it("saves and loads checkpoint state", () => {
    cp.save("task-fix-login", {
      workflowId: "test_workflow",
      sessionId: "sess-1",
      agentId: "opencode",
      stepResults: {
        spec: { status: "completed", output: "spec content", retries: 0 },
        code: { status: "failed", error: "syntax error", retries: 1 },
      },
      context: { task: "fix login bug" },
    });
    const state = cp.load("task-fix-login");
    expect(state).not.toBeNull();
    expect(state!.workflowId).toBe("test_workflow");
    expect(state!.sessionId).toBe("sess-1");
    expect(state!.agentId).toBe("opencode");
    expect(state!.stepResults["spec"].status).toBe("completed");
    expect(state!.stepResults["spec"].output).toBe("spec content");
    expect(state!.stepResults["code"].status).toBe("failed");
    expect(state!.stepResults["code"].error).toBe("syntax error");
  });

  it("returns null for unknown task", () => {
    const state = cp.load("nonexistent");
    expect(state).toBeNull();
  });

  it("updates existing checkpoint on save", () => {
    cp.save("task-1", {
      workflowId: "w1",
      sessionId: "s1",
      agentId: "o",
      stepResults: { a: { status: "completed", retries: 0 } },
      context: {},
    });
    cp.save("task-1", {
      workflowId: "w1",
      sessionId: "s1",
      agentId: "o",
      stepResults: {
        a: { status: "completed", retries: 0 },
        b: { status: "completed", retries: 0 },
      },
      context: {},
    });
    const state = cp.load("task-1");
    expect(Object.keys(state!.stepResults)).toEqual(["a", "b"]);
  });

  it("prunes checkpoint", () => {
    cp.save("task-1", {
      workflowId: "w1",
      sessionId: "s1",
      agentId: "o",
      stepResults: { a: { status: "completed", retries: 0 } },
      context: {},
    });
    cp.prune("task-1");
    expect(cp.load("task-1")).toBeNull();
  });

  it("handles multiple tasks independently", () => {
    cp.save("task-a", {
      workflowId: "w1",
      sessionId: "s1",
      agentId: "o",
      stepResults: { a1: { status: "completed", retries: 0 } },
      context: {},
    });
    cp.save("task-b", {
      workflowId: "w2",
      sessionId: "s2",
      agentId: "a",
      stepResults: { b1: { status: "completed", retries: 0 } },
      context: {},
    });
    expect(cp.load("task-a")!.workflowId).toBe("w1");
    expect(cp.load("task-b")!.workflowId).toBe("w2");
  });
});
