import { describe, it, expect } from "vitest";
import { runWorkflow, type RunContext, type StepHandler } from "../../../../application/harness/execution/step-runner.js";
import type { WorkflowStep } from "../../../../core/schemas.js";

const sig = (name: string): { name: string; description: string } => ({ name, description: name });

function mkCtx(): RunContext {
  return {
    workflowId: "wf1",
    stepResults: new Map(),
    buildResults: new Map(),
    maxRetries: 1,
    repairFeedbacks: new Map(),
  };
}

const okHandler: StepHandler = async (step) => {
  return { stepId: step.id, status: "completed", signal: step.emits[0].name, retries: 0 };
};

describe("step-runner", () => {
  it("runs entry steps seeded by __start__ (on: [__start__])", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "spec", agent: "a", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "code", agent: "b", emits: [sig("done")], on: ["spec.done"], context: [] },
    ];
    const ctx = mkCtx();
    await runWorkflow(steps, okHandler, ctx);
    expect(ctx.stepResults.get("spec")?.status).toBe("completed");
    expect(ctx.stepResults.get("code")?.status).toBe("completed");
  });

  it("AND join: consumer runs only after ALL on-refs fired", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "b", agent: "b1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "c", agent: "c1", emits: [sig("done")], on: ["a.done", "b.done"], context: [] },
    ];
    const ctx = mkCtx();
    let cCalls = 0;
    const handler: StepHandler = async (step) => {
      if (step.id === "c") cCalls++;
      return { stepId: step.id, status: "completed", signal: step.emits[0].name, retries: 0 };
    };
    await runWorkflow(steps, handler, ctx);
    expect(cCalls).toBe(1);
    expect(ctx.stepResults.get("c")?.status).toBe("completed");
  });

  it("OR join: consumer runs once when ANY any-ref fires", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "b", agent: "b1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "c", agent: "c1", emits: [sig("done")], any: ["a.done", "b.done"], context: [] },
    ];
    const ctx = mkCtx();
    let cCalls = 0;
    const handler: StepHandler = async (step) => {
      if (step.id === "c") cCalls++;
      return { stepId: step.id, status: "completed", signal: step.emits[0].name, retries: 0 };
    };
    await runWorkflow(steps, handler, ctx);
    expect(cCalls).toBe(1);
  });

  it("redo loop: sig_fail re-runs upstream producer via any edge", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "spec", agent: "a", emits: [sig("done")], any: ["__start__", "review.sig_fail"], context: [] },
      { type: "agent", id: "review", agent: "b", emits: [sig("sig_pass"), sig("sig_fail")], on: ["spec.done"], context: [] },
    ];

    let specCalls = 0;
    let reviewCalls = 0;
    const handler: StepHandler = async (step) => {
      if (step.id === "spec") {
        specCalls++;
        return { stepId: "spec", status: "completed", signal: "done", retries: 0 };
      }
      reviewCalls++;
      const signal = reviewCalls <= 2 ? "sig_fail" : "sig_pass";
      return { stepId: "review", status: "completed", signal, retries: 0 };
    };

    const ctx = mkCtx();
    const outcomes = await runWorkflow(steps, handler, ctx);

    expect(specCalls).toBe(3);
    expect(reviewCalls).toBe(3);
    expect(ctx.stepResults.get("spec")?.status).toBe("completed");
    expect(ctx.stepResults.get("review")?.status).toBe("completed");
    const reviewOutcome = outcomes.find(o => o.stepId === "review")!;
    expect(reviewOutcome.signal).toBe("sig_pass");
  });

  it("re-running producer re-runs its on-consumers (generation counting)", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "spec", agent: "a", emits: [sig("done")], any: ["__start__", "review.sig_fail"], context: [] },
      { type: "agent", id: "review", agent: "b", emits: [sig("sig_pass"), sig("sig_fail")], on: ["spec.done"], context: [] },
      { type: "agent", id: "code", agent: "c", emits: [sig("done")], on: ["spec.done"], context: [] },
    ];

    let specCalls = 0;
    let reviewCalls = 0;
    let codeCalls = 0;
    const handler: StepHandler = async (step) => {
      if (step.id === "spec") specCalls++;
      if (step.id === "review") {
        reviewCalls++;
        return { stepId: "review", status: "completed", signal: reviewCalls === 1 ? "sig_fail" : "sig_pass", retries: 0 };
      }
      if (step.id === "code") codeCalls++;
      return { stepId: step.id, status: "completed", signal: "done", retries: 0 };
    };

    const ctx = mkCtx();
    await runWorkflow(steps, handler, ctx);

    expect(specCalls).toBe(2);
    expect(reviewCalls).toBe(2);
    expect(codeCalls).toBe(2);
  });

  it("invalid emitted signal marks step failed", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("good")], on: ["__start__"], context: [] },
    ];
    const handler: StepHandler = async (step) => {
      return { stepId: step.id, status: "completed", signal: "nope", retries: 0 };
    };
    const ctx = mkCtx();
    await runWorkflow(steps, handler, ctx);
    expect(ctx.stepResults.get("a")?.status).toBe("failed");
    expect(ctx.stepResults.get("a")?.error).toContain("emits");
  });

  it("failed step propagates failure to its consumers", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "b", agent: "b1", emits: [sig("done")], on: ["a.done"], context: [] },
      { type: "agent", id: "c", agent: "c1", emits: [sig("done")], on: ["b.done"], context: [] },
    ];
    const handler: StepHandler = async (step) => {
      if (step.id === "a") return { stepId: "a", status: "failed", error: "agent crash", retries: 0 };
      return { stepId: step.id, status: "completed", signal: step.emits[0].name, retries: 0 };
    };
    const ctx = mkCtx();
    await runWorkflow(steps, handler, ctx);
    expect(ctx.stepResults.get("a")?.status).toBe("failed");
    expect(ctx.stepResults.get("b")?.status).toBe("failed");
    expect(ctx.stepResults.get("c")?.status).toBe("failed");
  });

  it("on-consumer of a failed producer is marked failed and never runs", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "gate", agent: "g", emits: [sig("sig_pass"), sig("sig_fail")], on: ["a.done"], context: [] },
    ];
    let gateCalls = 0;
    const handler: StepHandler = async (step) => {
      if (step.id === "gate") gateCalls++;
      if (step.id === "a") return { stepId: "a", status: "failed", error: "boom", retries: 0 };
      return { stepId: step.id, status: "completed", signal: step.emits[0].name, retries: 0 };
    };
    const ctx = mkCtx();
    await runWorkflow(steps, handler, ctx);
    expect(gateCalls).toBe(0);
    expect(ctx.stepResults.get("gate")?.status).toBe("failed");
  });

  it("throws on graph validation failure (unknown signal ref)", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "b", agent: "b1", emits: [sig("done")], on: ["missing.done"], context: [] },
    ];
    const ctx = mkCtx();
    await expect(runWorkflow(steps, okHandler, ctx)).rejects.toThrow(/failed graph validation/);
  });

  it("throws on unknown producer step", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("done")], on: ["ghost.done"], context: [] },
    ];
    const ctx = mkCtx();
    await expect(runWorkflow(steps, okHandler, ctx)).rejects.toThrow(/unknown step/);
  });

  it("a throwing handler fails the step and cascades instead of hanging (F1)", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "b", agent: "b1", emits: [sig("done")], on: ["a.done"], context: [] },
      { type: "agent", id: "c", agent: "c1", emits: [sig("done")], on: ["b.done"], context: [] },
    ];
    const handler: StepHandler = async (step) => {
      if (step.id === "a") throw new Error("agent exploded");
      return { stepId: step.id, status: "completed", signal: step.emits[0].name, retries: 0 };
    };
    const ctx = mkCtx();
    // Must RESOLVE (old code hung because running/consume state leaked).
    const outcomes = await runWorkflow(steps, handler, ctx);
    expect(ctx.stepResults.get("a")?.status).toBe("failed");
    expect(ctx.stepResults.get("a")?.error).toContain("agent exploded");
    expect(ctx.stepResults.get("b")?.status).toBe("failed");
    expect(ctx.stepResults.get("c")?.status).toBe("failed");
    expect(outcomes.filter(o => o.status === "failed").length).toBe(3);
  });

  it("a failed producer overwrites a consumer completed in an earlier redo generation (F3)", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "spec", agent: "a", emits: [sig("done")], any: ["__start__", "review.sig_fail"], context: [] },
      { type: "agent", id: "review", agent: "b", emits: [sig("sig_pass"), sig("sig_fail")], on: ["spec.done"], context: [] },
      { type: "agent", id: "code", agent: "c", emits: [sig("done")], on: ["spec.done"], context: [] },
    ];
    let specCalls = 0;
    let reviewCalls = 0;
    let codeCalls = 0;
    const handler: StepHandler = async (step) => {
      if (step.id === "spec") {
        specCalls++;
        // gen1 completes; gen2 hard-fails.
        if (specCalls > 1) return { stepId: "spec", status: "failed", error: "agent crash", retries: 0 };
        return { stepId: "spec", status: "completed", signal: "done", retries: 0 };
      }
      if (step.id === "review") { reviewCalls++; return { stepId: "review", status: "completed", signal: "sig_fail", retries: 0 }; }
      codeCalls++;
      return { stepId: "code", status: "completed", signal: "done", retries: 0 };
    };
    const ctx = mkCtx();
    await runWorkflow(steps, handler, ctx);
    expect(specCalls).toBe(2);
    expect(reviewCalls).toBe(1);
    expect(codeCalls).toBe(1);
    // code completed in gen1, but its only branch (spec) is now dead → must be failed, not stale-completed.
    expect(ctx.stepResults.get("spec")?.status).toBe("failed");
    expect(ctx.stepResults.get("review")?.status).toBe("failed");
    expect(ctx.stepResults.get("code")?.status).toBe("failed");
  });

  it("attachRepair only matches the newly-fired ref, not a stale one (F4)", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "gate1", agent: "g1", emits: [sig("sig_fail_a")], on: ["__start__"], context: [] },
      { type: "agent", id: "gate2", agent: "g2", emits: [sig("sig_fail_b")], on: ["redo.done"], context: [] },
      { type: "agent", id: "redo", agent: "r", emits: [sig("done")], any: ["gate1.sig_fail_a", "gate2.sig_fail_b"], context: [] },
    ];
    const staleFeedback = { gateId: "gate2", result: { exitCode: 1 } as any };
    const ctx = mkCtx();
    ctx.repairFeedbacks.set("gate2.sig_fail_b", staleFeedback);

    const seenPending: any[] = [];
    const handler: StepHandler = async (step) => {
      if (step.id === "redo") seenPending.push(ctx.pendingRepair);
      return { stepId: step.id, status: "completed", signal: step.emits[0].name, retries: 0 };
    };
    await runWorkflow(steps, handler, ctx);

    // redo #1 is fired by gate1.sig_fail_a only (gate2 has not emitted yet), so
    // gate2's stale feedback must NOT be picked up even though it sits in
    // repairFeedbacks. (Old code scanned the full ref list and did pick it up.)
    expect(seenPending[0]).toBeUndefined();
    // redo #2 is genuinely triggered by gate2.sig_fail_b -> its feedback attaches.
    expect(seenPending[1]).toBe(staleFeedback);
  });

  it("abort before dispatch runs no steps and marks every step cancelled", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "b", agent: "b1", emits: [sig("done")], on: ["a.done"], context: [] },
    ];
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx = mkCtx();
    ctx.signal = ctrl.signal;
    let calls = 0;
    const handler: StepHandler = async (step) => {
      calls++;
      return { stepId: step.id, status: "completed", signal: step.emits[0].name, retries: 0 };
    };
    const outcomes = await runWorkflow(steps, handler, ctx);
    expect(calls).toBe(0);
    expect(outcomes.map(o => o.error)).toEqual(["cancelled", "cancelled"]);
  });

  it("abort mid-run stops new dispatches and marks the un-run tail cancelled", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "b", agent: "b1", emits: [sig("done")], on: ["a.done"], context: [] },
      { type: "agent", id: "c", agent: "c1", emits: [sig("done")], on: ["b.done"], context: [] },
    ];
    const ctrl = new AbortController();
    const ctx = mkCtx();
    ctx.signal = ctrl.signal;
    let aCalls = 0;
    let bCalls = 0;
    let resolveA!: () => void;
    const gateA = new Promise<void>(r => { resolveA = r; });
    const handler: StepHandler = async (step) => {
      if (step.id === "a") {
        aCalls++;
        await gateA;
        return { stepId: "a", status: "completed", signal: "done", retries: 0 };
      }
      bCalls++;
      return { stepId: step.id, status: "completed", signal: step.emits[0].name, retries: 0 };
    };

    const p = runWorkflow(steps, handler, ctx);
    await Promise.resolve();
    expect(aCalls).toBe(1);
    ctrl.abort();
    resolveA();
    const outcomes = await p;

    expect(bCalls).toBe(0);
    // a settled as completed (test handler ignores the signal); b/c never
    // dispatched and are failed "cancelled" so the report shows the full tail.
    expect(ctx.stepResults.get("b")?.status).toBe("failed");
    expect(ctx.stepResults.get("b")?.error).toBe("cancelled");
    expect(ctx.stepResults.get("c")?.status).toBe("failed");
    expect(ctx.stepResults.get("c")?.error).toBe("cancelled");
    expect(outcomes.filter(o => o.status === "failed").length).toBe(2);
  });

  it("a paused outcome halts the run: downstream stays pending, no signal emitted", async () => {
    const steps: WorkflowStep[] = [
      { type: "agent", id: "a", agent: "a1", emits: [sig("done")], on: ["__start__"], context: [] },
      { type: "agent", id: "b", agent: "b1", emits: [sig("done")], on: ["a.done"], context: [] },
    ];
    const ctx = mkCtx();
    let bCalls = 0;
    const outcomes = await runWorkflow(steps, async (step) => {
      if (step.id === "a") {
        return {
          stepId: "a",
          status: "paused" as const,
          retries: 0,
          error: "[quota] You exceeded your current quota",
          failureReason: "quota_exhausted",
          quota: { kind: "quota", resetAtMs: 1755600000000, message: "quota exceeded" },
        };
      }
      bCalls++;
      return { stepId: step.id, status: "completed", signal: step.emits[0].name, retries: 0 };
    }, ctx);

    // The paused step is recorded with its full quota payload...
    expect(ctx.stepResults.get("a")?.status).toBe("paused");
    expect(ctx.stepResults.get("a")?.quota).toEqual({ kind: "quota", resetAtMs: 1755600000000, message: "quota exceeded" });
    // ...but downstream never dispatches and the run resolves (paused), not hangs.
    expect(bCalls).toBe(0);
    expect(ctx.stepResults.get("b")).toBeUndefined();
    expect(outcomes.map(o => o.stepId)).toEqual(["a"]);
    expect(outcomes[0].status).toBe("paused");
  });
});
