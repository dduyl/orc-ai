import { describe, it, expect } from "vitest";
import { runWorkflow, resolveReady, type RunContext, type StepOutcome } from "../../../../application/harness/execution/step-runner.js";
import type { WorkflowStep } from "../../../../core/schemas.js";

describe("step-runner", () => {
  it("resolves ready steps based on dependencies", () => {
    const steps: WorkflowStep[] = [
      { id: "s1", agent: "a", depends_on: [], context: [] },
      { id: "s2", agent: "b", depends_on: ["s1"], context: [] },
    ];
    const ctx: RunContext = {
      workflowId: "wf1",
      stepResults: new Map(),
      buildResults: new Map(),
      maxRetries: 1,
    };

    let ready = resolveReady(steps, ctx);
    expect(ready.map((s: WorkflowStep) => s.id)).toEqual(["s1"]);

    ctx.stepResults.set("s1", { stepId: "s1", status: "completed", retries: 0 });
    ready = resolveReady(steps, ctx);
    expect(ready.map((s: WorkflowStep) => s.id)).toEqual(["s2"]);
  });
});
