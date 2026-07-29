import { describe, it, expect } from "vitest";
import { runWorkflow, resolveReady, type RunContext, type StepHandler, type StepOutcome } from "../../../../application/harness/execution/step-runner.js";
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

  it("re-runs target step when signal is false (signal_off) with cascade reset", async () => {
    const steps: WorkflowStep[] = [
      { id: "spec", agent: "a", depends_on: [], context: [] },
      {
        id: "review", agent: "b", depends_on: ["spec"], context: [],
        signal: { name: "ok", description: "", signal_on: null, signal_off: "spec" },
      },
    ];

    let reviewCalls = 0;
    const handler: StepHandler = async (step) => {
      if (step.id === "review") {
        reviewCalls++;
        if (reviewCalls <= 2) {
          return { stepId: "review", status: "completed", signal: false, retries: 0 };
        }
        return { stepId: "review", status: "completed", retries: 0 };
      }
      return { stepId: step.id, status: "completed", retries: 0 };
    };

    const ctx: RunContext = {
      workflowId: "wf1",
      stepResults: new Map(),
      buildResults: new Map(),
      maxRetries: 1,
    };

    const outcomes = await runWorkflow(steps, handler, ctx);

    expect(reviewCalls).toBe(3);
    expect(ctx.stepResults.get("spec")?.status).toBe("completed");
    expect(ctx.stepResults.get("review")?.status).toBe("completed");
    expect(outcomes.length).toBe(2);
    const reviewOutcome = outcomes.find(o => o.stepId === "review")!;
    expect(reviewOutcome.signal).toBeUndefined();
  });

  it("does not loop when signal is undefined", async () => {
    const steps: WorkflowStep[] = [
      { id: "spec", agent: "a", depends_on: [], context: [] },
      {
        id: "review", agent: "b", depends_on: ["spec"], context: [],
        signal: { name: "ok", description: "", signal_on: null, signal_off: "spec" },
      },
    ];

    let reviewCalls = 0;
    const handler: StepHandler = async (step) => {
      if (step.id === "review") {
        reviewCalls++;
      }
      return { stepId: step.id, status: "completed", retries: 0 };
    };

    const ctx: RunContext = {
      workflowId: "wf1",
      stepResults: new Map(),
      buildResults: new Map(),
      maxRetries: 1,
    };

    await runWorkflow(steps, handler, ctx);

    expect(reviewCalls).toBe(1);
    expect(ctx.stepResults.get("spec")?.status).toBe("completed");
    expect(ctx.stepResults.get("review")?.status).toBe("completed");
  });

  it("cascade reset clears dependent steps", async () => {
    const steps: WorkflowStep[] = [
      { id: "spec", agent: "a", depends_on: [], context: [] },
      {
        id: "review", agent: "b", depends_on: ["spec"], context: [],
        signal: { name: "ok", description: "", signal_on: null, signal_off: "spec" },
      },
      { id: "code", agent: "c", depends_on: ["review"], context: [] },
    ];

    let reviewCalls = 0;
    const handler: StepHandler = async (step) => {
      if (step.id === "review") {
        reviewCalls++;
        if (reviewCalls === 1) {
          return { stepId: "review", status: "completed", signal: false, retries: 0 };
        }
        return { stepId: "review", status: "completed", retries: 0 };
      }
      return { stepId: step.id, status: "completed", retries: 0 };
    };

    const ctx: RunContext = {
      workflowId: "wf1",
      stepResults: new Map(),
      buildResults: new Map(),
      maxRetries: 1,
    };

    const outcomes = await runWorkflow(steps, handler, ctx);

    expect(reviewCalls).toBe(2);
    expect(ctx.stepResults.get("spec")?.status).toBe("completed");
    expect(ctx.stepResults.get("review")?.status).toBe("completed");
    expect(ctx.stepResults.get("code")?.status).toBe("completed");
    const allIds = outcomes.map(o => o.stepId);
    expect(allIds).toContain("code");
  });

  it("runs signal_on target when signal is true", async () => {
    const steps: WorkflowStep[] = [
      {
        id: "validate", agent: "a", depends_on: [], context: [],
        signal: { name: "ok", description: "", signal_on: "next", signal_off: null },
      },
      { id: "next", agent: "b", depends_on: [], context: [] },
    ];

    const handler: StepHandler = async (step) => {
      if (step.id === "validate") {
        return { stepId: "validate", status: "completed", signal: true, retries: 0 };
      }
      return { stepId: step.id, status: "completed", retries: 0 };
    };

    const ctx: RunContext = {
      workflowId: "wf1",
      stepResults: new Map(),
      buildResults: new Map(),
      maxRetries: 1,
    };

    const outcomes = await runWorkflow(steps, handler, ctx);

    expect(ctx.stepResults.get("validate")?.status).toBe("completed");
    expect(ctx.stepResults.get("next")?.status).toBe("completed");
    const nextOutcome = outcomes.find(o => o.stepId === "next");
    expect(nextOutcome).toBeDefined();
  });

  it("signal unset step does not trigger loopback", async () => {
    const steps: WorkflowStep[] = [
      { id: "spec", agent: "a", depends_on: [], context: [] },
      { id: "code", agent: "b", depends_on: ["spec"], context: [] },
    ];

    let codeCalls = 0;
    const handler: StepHandler = async (step) => {
      codeCalls++;
      return { stepId: step.id, status: "completed", retries: 0 };
    };

    const ctx: RunContext = {
      workflowId: "wf1",
      stepResults: new Map(),
      buildResults: new Map(),
      maxRetries: 1,
    };

    await runWorkflow(steps, handler, ctx);

    expect(codeCalls).toBe(2);
  });
});
