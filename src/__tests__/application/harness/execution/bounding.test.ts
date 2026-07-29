import { describe, it, expect } from "vitest";
import { checkStepBudget, detectLoop } from "../../../../application/harness/execution/bounding.js";
import type { StepOutcome } from "../../../../application/harness/execution/step-runner.js";

describe("bounding", () => {
  it("checks step budget", () => {
    expect(checkStepBudget(5).ok).toBe(true);
    expect(checkStepBudget(50).ok).toBe(false);
  });

  it("detects loops", () => {
    const recent: StepOutcome[] = [
      { stepId: "s1", status: "failed", retries: 1 },
      { stepId: "s1", status: "failed", retries: 2 },
      { stepId: "s1", status: "failed", retries: 3 },
      { stepId: "s1", status: "failed", retries: 4 },
      { stepId: "s1", status: "failed", retries: 5 },
      { stepId: "s1", status: "failed", retries: 6 },
    ];
    const check = detectLoop(recent, 5);
    expect(check.ok).toBe(false);
  });
});
