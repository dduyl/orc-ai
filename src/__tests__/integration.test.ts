import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkflowRegistry } from "../planner/registry.js";
import { runWorkflow, type RunContext, type StepHandler, type StepOutcome } from "../harness/step-runner.js";
import { checkStepBudget, detectLoop } from "../harness/bounding.js";

import type { WorkflowDefinition } from "../schemas.js";
import { def } from "../schemas.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const featureImpl: WorkflowDefinition = def({
  version: 1,
  workflow: {
    id: "feature_implementation",
    name: "Feature Implementation",
    steps: [
      { id: "spec", agent: "requirement_analyst", depends_on: [], task: "a" },
      { id: "review_spec", agent: "review", depends_on: ["spec"], task: "Review spec", signal: { name: "spec_ok", description: "x", signal_on: null, signal_off: "spec" } },
      { id: "architecture", agent: "architecture_agent", depends_on: ["review_spec"], task: "b" },
      { id: "review_arch", agent: "review", depends_on: ["architecture"], task: "Review arch", signal: { name: "arch_ok", description: "x", signal_on: null, signal_off: "architecture" } },
      { id: "code", agent: "code_generation_backend", depends_on: ["review_arch"], task: "c", context: ["spec", "architecture"] },
      { id: "test", agent: "test_generation_backend", depends_on: ["review_arch"], task: "d", context: ["spec", "code"] },
      { id: "review_code", agent: "review", depends_on: ["code"], task: "Review code", signal: { name: "code_ok", description: "x", signal_on: null, signal_off: "code" } },
      { id: "review_test", agent: "review", depends_on: ["test"], task: "Review tests", signal: { name: "test_ok", description: "x", signal_on: null, signal_off: "test" } },
    ],
    completion: "Done",
  },
});

const issueToFix: WorkflowDefinition = def({
  version: 1,
  workflow: {
    id: "issue_to_fix",
    name: "Issue to Fix",
    steps: [
      { id: "spec", agent: "requirement_analyst", depends_on: [], task: "a" },
      { id: "review_spec", agent: "review", depends_on: ["spec"], task: "Review spec", signal: { name: "spec_ok", description: "x", signal_on: null, signal_off: "spec" } },
      { id: "code", agent: "code_generation_backend", depends_on: ["review_spec"], task: "b" },
      { id: "review_code", agent: "review", depends_on: ["code"], task: "Review code", signal: { name: "code_ok", description: "x", signal_on: null, signal_off: "code" } },
    ],
    completion: "Done",
  },
});

const bugfix: WorkflowDefinition = def({
  version: 1,
  workflow: {
    id: "bugfix",
    name: "Bugfix",
    steps: [
      { id: "spec", agent: "requirement_analyst", depends_on: [], task: "a" },
      { id: "review_spec", agent: "review", depends_on: ["spec"], task: "Review spec", signal: { name: "spec_ok", description: "x", signal_on: null, signal_off: "spec" } },
      { id: "code", agent: "code_generation_backend", depends_on: ["review_spec"], task: "b" },
      { id: "review_code", agent: "review", depends_on: ["code"], task: "Review code", signal: { name: "code_ok", description: "x", signal_on: null, signal_off: "code" } },
    ],
    completion: "Done",
  },
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orc-int-"));
}

function writeWorkflows(dir: string) {
  const wfs = [featureImpl, issueToFix, bugfix];
  for (const wf of wfs) {
    fs.writeFileSync(path.join(dir, `${wf.workflow.id}.json`), JSON.stringify(wf));
  }
}

describe("Integration: workflows load and are valid", () => {
  let dir: string;
  let reg: WorkflowRegistry;

  beforeEach(() => {
    dir = tmpDir();
    writeWorkflows(dir);
    reg = new WorkflowRegistry(dir);
  });

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("loads all 3 workflows", () => {
    const all = reg.loadAll();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const ids = all.map(w => w.id);
    expect(ids).toContain("feature_implementation");
    expect(ids).toContain("issue_to_fix");
    expect(ids).toContain("bugfix");
  });

  const allWfs = [featureImpl, issueToFix, bugfix];

  for (const wf of allWfs) {
    it(`workflow "${wf.workflow.id}" has valid steps`, () => {
      const steps = wf.workflow.steps;
      expect(steps.length).toBeGreaterThan(0);

      for (const step of steps) {
        expect(step.id).toBeTruthy();
        expect(["requirement_analyst", "architecture_agent", "code_generation_backend", "test_generation_backend", "review"]).toContain(step.agent);
      }
    });
  }
});


describe("Integration: workflow runner with mock handler", () => {
  const passHandler: StepHandler = async (s) => ({
    stepId: s.id, status: "completed", output: "ok", retries: 0,
  });

  it("runs feature_implementation steps with per-step review", async () => {
    const ctx: RunContext = {
      workflowId: featureImpl.workflow.id,
      stepResults: new Map(),
      buildResults: new Map(),
      maxRetries: 2,
    };
    const outcomes = await runWorkflow(featureImpl.workflow.steps, passHandler, ctx);
    expect(outcomes).toHaveLength(featureImpl.workflow.steps.length);
    expect(outcomes.every(o => o.status === "completed")).toBe(true);
  });

  it("runs issue_to_fix workflow", async () => {
    const ctx: RunContext = {
      workflowId: issueToFix.workflow.id,
      stepResults: new Map(),
      buildResults: new Map(),
      maxRetries: 2,
    };
    const outcomes = await runWorkflow(issueToFix.workflow.steps, passHandler, ctx);
    expect(outcomes.every(o => o.status === "completed")).toBe(true);
  });

  it("continues past failure (Option A)", async () => {
    const failOnCode: StepHandler = async (s) =>
      s.id === "code"
        ? { stepId: s.id, status: "failed", error: "intentional", retries: 1 }
        : { stepId: s.id, status: "completed", output: "ok", retries: 0 };

    const ctx: RunContext = {
      workflowId: featureImpl.workflow.id,
      stepResults: new Map(),
      buildResults: new Map(),
      maxRetries: 2,
    };
    const outcomes = await runWorkflow(featureImpl.workflow.steps, failOnCode, ctx);
    expect(outcomes.find(o => o.stepId === "code")?.status).toBe("failed");
    // All steps should still run (Option A — no early return)
    expect(outcomes.length).toBe(featureImpl.workflow.steps.length);
  });
});

describe("Integration: bounding guards", () => {
  it("checkStepBudget stops at 50", () => {
    expect(checkStepBudget(50).ok).toBe(false);
  });

  it("detectLoop catches 6x same step", () => {
    const outcomes: StepOutcome[] = Array(6).fill(null).map(() => ({
      stepId: "code", status: "failed", retries: 0,
    }));
    expect(detectLoop(outcomes, 5).ok).toBe(false);
  });
});
