import { describe, it, expect } from "vitest";
import { Checkpointer } from "../../../../application/harness/persistence/Checkpointer.js";
import * as path from "node:path";
import * as os from "node:os";

describe("Checkpointer", () => {
  it("saves and loads checkpoint state", () => {
    const tmpDir = path.join(os.tmpdir(), `orc-cp-test-${Date.now()}`);
    const dbPath = path.join(tmpDir, "checkpoints.sqlite");
    const cp = new Checkpointer(dbPath);

    cp.save("test-task-1", {
      workflowId: "wf-1",
      sessionId: "sess-1",
      agentId: "opencode",
      stepResults: {
        step1: { status: "completed", output: "done", retries: 0 },
      },
      context: { key: "val" },
    });

    const loaded = cp.load("test-task-1");
    expect(loaded).not.toBeNull();
    expect(loaded?.workflowId).toBe("wf-1");
    expect(loaded?.sessionId).toBe("sess-1");
    expect(loaded?.stepResults.step1.status).toBe("completed");

    cp.prune("test-task-1");
    expect(cp.load("test-task-1")).toBeNull();

    cp.close();
  });
});
