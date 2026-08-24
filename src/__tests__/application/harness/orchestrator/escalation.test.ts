import { describe, it, expect } from "vitest";
import { FailureReason, StepStatus } from "../../../../core/types.js";
import { Tracker } from "../../../../application/harness/persistence/Tracker.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("harness/orchestrator/escalation (ADR-016)", () => {
  it("defines NeedsHuman in StepStatus and FailureReason", () => {
    expect(StepStatus.NeedsHuman).toBe("needs_human");
    expect(FailureReason.NeedsHuman).toBe("needs_human");
    expect(FailureReason.LoopDetected).toBe("loop_detected");
    expect(FailureReason.BudgetExceeded).toBe("budget_exceeded");
    expect(FailureReason.ExhaustedRetries).toBe("exhausted_retries");
  });

  it("updates tracker run status to needs_human when escalated", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-escalation-test-"));
    const dbPath = path.join(tmpDir, "runs.sqlite");
    const tracker = new Tracker(dbPath);

    const runId = "test-escalation-run";
    tracker.createRun(
      runId,
      "feat-impl",
      "Feature Implementation",
      "Implement feature",
      "opencode",
      [
        {
          stepId: "spec",
          agent: "spec",
          task: "Analyze spec",
          signals: [],
        },
      ],
    );

    tracker.updateRunStatus(runId, "needs_human");
    const run = tracker.getRun(runId);
    expect(run).toBeDefined();
    expect(run?.status).toBe("needs_human");

    tracker.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
