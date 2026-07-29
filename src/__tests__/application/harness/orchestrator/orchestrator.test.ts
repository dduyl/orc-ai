import { describe, it, expect } from "vitest";
import { orchestrate } from "../../../../application/harness/orchestrator/index.js";
import { registerStrategy, type AgentStrategy } from "../../../../application/agents/strategy.js";
import type { AdapterDef } from "../../../../application/agents/adapter.js";
import { WorkflowRegistry } from "../../../../application/planner/registry.js";

describe("Orchestrator", () => {
  it("exports orchestrate function", () => {
    expect(orchestrate).toBeDefined();
    expect(typeof orchestrate).toBe("function");
  });
});
