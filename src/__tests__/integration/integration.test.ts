import { describe, it, expect } from "vitest";
import { WorkflowRegistry } from "../../application/planner/registry.js";
import { runWorkflow } from "../../application/harness/execution/step-runner.js";
import { checkStepBudget } from "../../application/harness/execution/bounding.js";
import { WorkflowDefinition, type WorkflowStep } from "../../core/schemas.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Integration Workflow", () => {
  it("runs full workflow execution flow", async () => {
    const tmpDir = path.join(os.tmpdir(), `orc-integ-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const registry = new WorkflowRegistry({ userDir: tmpDir });
    expect(registry.count()).toBe(0);

    const steps: WorkflowStep[] = [
      { id: "s1", agent: "analyst", depends_on: [], context: [] },
      { id: "s2", agent: "codegen", depends_on: ["s1"], context: [] },
    ];

    const outcomes = await runWorkflow(
      steps,
      async (step: WorkflowStep) => ({ stepId: step.id, status: "completed", output: "ok", retries: 0 }),
      { workflowId: "wf1", stepResults: new Map(), buildResults: new Map(), maxRetries: 1 },
    );

    expect(outcomes.length).toBe(2);
    expect(outcomes.every((o: import("../../application/harness/execution/step-runner.js").StepOutcome) => o.status === "completed")).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
