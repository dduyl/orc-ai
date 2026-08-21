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
});