import { describe, it, expect } from "vitest";
import { runWorkflow, resolveReady, type RunContext, type StepHandler, type StepOutcome } from "../harness/step-runner.js";
import type { WorkflowStep } from "../schemas.js";

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id: "s1", agent: "requirement_analyst", depends_on: [], ...overrides } as WorkflowStep;
}

function freshCtx(): RunContext {
  return { workflowId: "test", stepResults: new Map(), buildResults: new Map(), maxRetries: 2 };
}

describe("resolveReady", () => {
  it("returns steps with no deps", () => {
    const ctx = freshCtx();
    const steps = [makeStep({ id: "a" }), makeStep({ id: "b" })];
    expect(resolveReady(steps, ctx).map(s => s.id)).toEqual(["a", "b"]);
  });

  it("returns steps whose deps are completed", () => {
    const ctx = freshCtx();
    ctx.stepResults.set("a", { stepId: "a", status: "completed", retries: 0 });
    const steps = [makeStep({ id: "b", depends_on: ["a"] })];
    expect(resolveReady(steps, ctx).map(s => s.id)).toEqual(["b"]);
  });

  it("skips steps whose deps are not done", () => {
    const ctx = freshCtx();
    const steps = [makeStep({ id: "b", depends_on: ["a"] })];
    expect(resolveReady(steps, ctx)).toEqual([]);
  });

  it("skips already-run steps", () => {
    const ctx = freshCtx();
    ctx.stepResults.set("a", { stepId: "a", status: "completed", retries: 0 });
    const steps = [makeStep({ id: "a" })];
    expect(resolveReady(steps, ctx)).toEqual([]);
  });
});

describe("runWorkflow", () => {
  it("runs sequential steps", async () => {
    const ctx = freshCtx();
    const steps = [makeStep({ id: "a" }), makeStep({ id: "b", depends_on: ["a"] })];
    const handler: StepHandler = async (s) => ({ stepId: s.id, status: "completed", output: "ok", retries: 0 });
    const outcomes = await runWorkflow(steps, handler, ctx);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map(o => o.status)).toEqual(["completed", "completed"]);
  });

  it("continues after failure (Option A)", async () => {
    const ctx = freshCtx();
    const steps = [makeStep({ id: "a" }), makeStep({ id: "b" })];
    const handler: StepHandler = async (s) =>
      s.id === "a"
        ? { stepId: "a", status: "failed", error: "fail", retries: 0 }
        : { stepId: s.id, status: "completed", output: "ok", retries: 0 };
    const outcomes = await runWorkflow(steps, handler, ctx);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[1].status).toBe("completed");
  });

  it("detects unresolvable deps", async () => {
    const ctx = freshCtx();
    const steps = [makeStep({ id: "a", depends_on: ["nonexistent"] })];
    const handler: StepHandler = async (s) => ({ stepId: s.id, status: "completed", output: "ok", retries: 0 });
    const outcomes = await runWorkflow(steps, handler, ctx);
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error).toContain("Unresolved");
  });

  it("runs parallel branches concurrently", async () => {
    const ctx = freshCtx();
    const steps: WorkflowStep[] = [
      makeStep({ id: "root" }),
      makeStep({ id: "a", depends_on: ["root"] }),
      makeStep({ id: "b", depends_on: ["root"] }),
    ];
    const order: string[] = [];
    const handler: StepHandler = async (s) => {
      await new Promise(r => setTimeout(r, 10));
      order.push(s.id);
      return { stepId: s.id, status: "completed", output: "ok", retries: 0 };
    };
    const outcomes = await runWorkflow(steps, handler, ctx);
    expect(outcomes).toHaveLength(3);
    expect(order[0]).toBe("root");
    expect(order.slice(1).sort()).toEqual(["a", "b"]);
  });

  it("re-dispatches upstream on signal_off when signal=false", async () => {
    const ctx = freshCtx();
    let count = 0;
    const steps = [
      { id: "code", agent: "code_generation_backend", depends_on: [] },
      { id: "review_code", agent: "review", depends_on: ["code"], signal: { name: "review_ok", description: "x", signal_on: null, signal_off: "code" } },
    ] as WorkflowStep[];
    const handler: StepHandler = async (s) => {
      count++;
      if (s.id === "review_code" && count === 2) {
        return { stepId: "review_code", status: "completed", output: "ok", retries: 0, signal: false };
      }
      return { stepId: s.id, status: "completed", output: "ok", retries: 0, signal: true };
    };
    const outcomes = await runWorkflow(steps, handler, ctx);
    expect(count).toBe(4);
    expect(outcomes.every(o => o.status === "completed")).toBe(true);
  });
});
