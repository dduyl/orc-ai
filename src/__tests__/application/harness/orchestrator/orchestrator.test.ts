import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { orchestrate } from "../../../../application/harness/orchestrator/index.js";
import type { AdapterDef } from "../../../../application/agents/adapter.js";

const { stepHandlerOptions } = vi.hoisted(() => ({ stepHandlerOptions: [] as unknown[] }));

// Spy on the production createStepHandler call site (orchestrator.ts) so the
// H1 test can assert which seams the orchestrator actually wires, without
// exercising the whole ACP/PTY path.
vi.mock("../../../../application/harness/orchestrator/step-handler.js", () => ({
  createStepHandler: vi.fn((options: unknown) => {
    stepHandlerOptions.push(options);
    return async (step: { id: string }) => ({ stepId: step.id, status: "completed", retries: 0 });
  }),
}));

const plan = {
  workflow: {
    schemaVersion: 1,
    workflow: { id: "w", name: "w", description: "d", steps: [], completion: "done" },
  },
  source: "registered",
} as any;

function fakeCheckpointer() {
  return { save: vi.fn(), load: vi.fn(), prune: vi.fn(), close: vi.fn() } as any;
}

describe("Orchestrator", () => {
  beforeEach(() => {
    stepHandlerOptions.length = 0;
  });

  it("exports orchestrate function", () => {
    expect(orchestrate).toBeDefined();
    expect(typeof orchestrate).toBe("function");
  });

  it("wires the quota-ladder seams into createStepHandler (H1)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orc-orch-"));
    const cp = fakeCheckpointer();
    try {
      const report = await orchestrate("task", {
        adapter: { id: "test", command: "test", label: "test" } as AdapterDef,
        plan,
        checkpointer: cp,
        projectRoot: root,
      });
      expect(report.outcomes).toEqual([]);
      expect(report.totalSteps).toBe(0);

      expect(stepHandlerOptions.length).toBe(1);
      const opts = stepHandlerOptions[0] as Record<string, unknown>;
      expect(opts.modelRoutingConfig).toBeDefined();
      expect(typeof opts.resolveVariantTier).toBe("function");
      expect(typeof opts.resolveDowngradeModel).toBe("function");
      expect(typeof opts.onProviderQuota).toBe("function");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes checkpoint when all failures are cancelled (user cancel)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orc-orch-cancel-"));
    const cp = fakeCheckpointer();
    const ctrl = new AbortController();
    try {
      // Mock step handler to produce cancelled outcomes
      vi.mocked(
        (await import("../../../../application/harness/orchestrator/step-handler.js")).createStepHandler,
      ).mockImplementationOnce(() => async (step: { id: string }) => ({
        stepId: step.id, status: "failed" as const, error: "cancelled", retries: 0,
      }));

      const report = await orchestrate("cancel-task", {
        adapter: { id: "test", command: "test", label: "test" } as AdapterDef,
        plan: {
          ...plan,
          workflow: {
            ...plan.workflow,
            workflow: {
              id: "w", name: "w", description: "d",
              steps: [
                { id: "s1", agent: "a", task: "t", emits: [{ name: "done", description: "d" }], on: ["__start__"] },
              ],
              completion: "done",
            },
          },
        },
        checkpointer: cp,
        projectRoot: root,
        signal: ctrl.signal,
      });

      // All steps should be failed with "cancelled" error
      expect(report.outcomes.every(o => o.status === "failed" && o.error === "cancelled")).toBe(true);
      // Checkpoint should be pruned — no useful recovery state
      expect(cp.prune).toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT prune checkpoint when failures are real errors (not cancelled)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orc-orch-fail-"));
    const cp = fakeCheckpointer();
    try {
      vi.mocked(
        (await import("../../../../application/harness/orchestrator/step-handler.js")).createStepHandler,
      ).mockImplementationOnce(() => async (step: { id: string }) => ({
        stepId: step.id, status: "failed" as const, error: "agent crashed", retries: 0,
      }));

      const report = await orchestrate("fail-task", {
        adapter: { id: "test", command: "test", label: "test" } as AdapterDef,
        plan: {
          ...plan,
          workflow: {
            ...plan.workflow,
            workflow: {
              id: "w", name: "w", description: "d",
              steps: [{ id: "s1", agent: "a", task: "t", emits: [{ name: "done", description: "d" }], on: ["__start__"] }],
              completion: "done",
            },
          },
        },
        checkpointer: cp,
        projectRoot: root,
      });

      expect(report.outcomes[0].error).toBe("agent crashed");
      // Real failure → checkpoint preserved for debugging
      expect(cp.prune).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});