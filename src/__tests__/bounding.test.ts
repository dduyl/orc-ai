import { describe, it, expect } from "vitest";
import { checkStepBudget, detectLoop } from "../harness/bounding.js";
import type { StepOutcome } from "../harness/step-runner.js";

describe("checkStepBudget", () => {
  it("passes when under budget", () => {
    expect(checkStepBudget(5).ok).toBe(true);
  });

  it("fails when at budget", () => {
    const result = checkStepBudget(50);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("budget exceeded");
  });
});

describe("detectLoop", () => {
  it("passes with few repetitions", () => {
    const recent: StepOutcome[] = [
      { stepId: "s1", status: "failed", retries: 0 },
      { stepId: "s1", status: "failed", retries: 0 },
    ];
    expect(detectLoop(recent, 2).ok).toBe(true);
  });

  it("detects excessive repetitions", () => {
    const recent: StepOutcome[] = Array(6).fill(null).map(() => ({
      stepId: "s1", status: "failed", retries: 0,
    }));
    const result = detectLoop(recent, 5);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Loop detected");
  });

  it("passes with empty or single item", () => {
    expect(detectLoop([], 5).ok).toBe(true);
    expect(detectLoop([{ stepId: "s1", status: "completed", retries: 0 }], 5).ok).toBe(true);
  });
});
