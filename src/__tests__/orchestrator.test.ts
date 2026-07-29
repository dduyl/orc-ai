import { describe, it, expect, beforeAll } from "vitest";
import { orchestrate } from "../harness/orchestrator.js";
import { registerStrategy } from "../agents/strategy.js";
import type { AdapterDef } from "../agents/adapter.js";
import type { PlannerResult } from "../planner/registry.js";

const echoAdapter: AdapterDef = { id: "echo", command: "cmd", label: "Echo" };

beforeAll(() => {
  registerStrategy({
    id: "echo",
    buildArgs: () => ["/c", "echo", "test-output"],
    keepAlive: false,
    isComplete: () => false,
    extractOutput: (s: string) => s.trim(),
  });
});

const testStep = {
  id: "s1", agent: "requirement_analyst",
  depends_on: [] as string[], context: [] as string[],
  task: "test",
};

const testPlan: PlannerResult = {
  workflow: {
    version: 1,
    workflow: {
      id: "test_wf",
      name: "Test",
      steps: [testStep],
      completion: "Done",
    },
  },
  source: "registered",
  registration: {
    id: "test_wf",
    name: "Test",
    filePath: "",
    definition: {
      version: 1,
      workflow: {
        id: "test_wf",
        name: "Test",
        steps: [testStep],
        completion: "Done",
      },
    },
  },
};

describe("orchestrate", () => {
  it("returns a report for a workflow", { timeout: 30000 }, async () => {
    const report = await orchestrate("test task", echoAdapter, testPlan);
    expect(report).toHaveProperty("workflowId");
    expect(report).toHaveProperty("totalSteps");
    expect(report).toHaveProperty("completed");
    expect(report).toHaveProperty("failed");
    expect(report).toHaveProperty("source");
  });
});


