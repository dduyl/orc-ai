import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WorkflowRegistry } from "../../../application/planner/registry.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("WorkflowRegistry", () => {
  let testDir: string;
  let registry: WorkflowRegistry;

  beforeEach(() => {
    testDir = join(tmpdir(), `orc-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    registry = new WorkflowRegistry({ userDir: testDir });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("loads builtin workflows", () => {
    const workflows = registry.loadAll();
    expect(workflows.length).toBeGreaterThanOrEqual(4);

    const ids = workflows.map(w => w.id);
    expect(ids).toContain("feature_implementation_builtin");
    expect(ids).toContain("bug_fix_builtin");
    expect(ids).toContain("review_cycle");
    expect(ids).toContain("noop_builtin");
  });

  it("returns workflow by id", () => {
    registry.loadAll();
    const wf = registry.get("feature_implementation_builtin");
    expect(wf).toBeDefined();
    expect(wf?.name).toBe("Feature Implementation (Built-in)");
  });

  it("returns workflow by name", () => {
    registry.loadAll();
    const wf = registry.findByName("Feature Implementation (Built-in)");
    expect(wf).toBeDefined();
    expect(wf?.id).toBe("feature_implementation_builtin");
  });

  it("lists all workflows", () => {
    registry.loadAll();
    const list = registry.list();
    expect(list.length).toBeGreaterThanOrEqual(4);
  });

  it("counts workflows correctly", () => {
    registry.loadAll();
    expect(registry.count()).toBeGreaterThanOrEqual(4);
  });

  it("loads user workflows from YAML", () => {
    const userWf = `
id: user_custom_workflow
name: Custom User Workflow
description: A custom workflow
steps:
  - id: step1
    agent: test_agent
    emits:
      - name: sig_done
        description: Done
    on: ["__start__"]
    task: "Do something"
completion: "Custom complete"
`;
    writeFileSync(join(testDir, "custom.yaml"), userWf);

    const workflows = registry.loadAll();
    const custom = workflows.find(w => w.id === "user_custom_workflow");
    expect(custom).toBeDefined();
    expect(custom?.name).toBe("Custom User Workflow");
    expect(custom?.filePath).toContain("custom.yaml");
  });

  it("loads user workflows from JSON", () => {
    const userWf = {
      version: 1,
      workflow: {
        id: "user_json_workflow",
        name: "JSON Workflow",
        description: "From JSON",
        steps: [
          {
            id: "step1",
            type: "agent",
            agent: "test_agent",
            emits: [{ name: "sig_done", description: "Done" }],
            on: ["__start__"],
            task: "Do something",
          },
        ],
        completion: "JSON complete",
      },
    };
    writeFileSync(join(testDir, "json.json"), JSON.stringify(userWf, null, 2));

    const workflows = registry.loadAll();
    const custom = workflows.find(w => w.id === "user_json_workflow");
    expect(custom).toBeDefined();
    expect(custom?.name).toBe("JSON Workflow");
  });

  it("user workflows override builtins with same id", () => {
    const userWf = `
id: feature_implementation_builtin
name: Overridden Feature Workflow
description: User version
steps:
  - id: step1
    agent: test_agent
    emits:
      - name: sig_done
        description: Done
    on: ["__start__"]
    task: "Do something"
completion: "Overridden"
`;
    writeFileSync(join(testDir, "override.yaml"), userWf);

    const workflows = registry.loadAll();
    const wf = workflows.find(w => w.id === "feature_implementation_builtin");
    expect(wf).toBeDefined();
    expect(wf?.name).toBe("Overridden Feature Workflow");
    expect(wf?.filePath).toContain("override.yaml");
  });

  it("saveDynamic writes JSON to user dir", () => {
    const wf = {
      version: 1,
      workflow: {
        id: "dynamic_workflow",
        name: "Dynamic Workflow",
        steps: [
          {
            id: "step1",
            type: "agent",
            agent: "test_agent",
            emits: [{ name: "sig_done", description: "Done" }],
            on: ["__start__"],
            task: "Do something",
          },
        ],
        completion: "Dynamic complete",
      },
    };

    registry.saveDynamic(wf as any);

    const workflows = registry.loadAll();
    const dynamic = workflows.find(w => w.id === "dynamic_workflow");
    expect(dynamic).toBeDefined();
    expect(dynamic?.name).toBe("Dynamic Workflow");
    expect(dynamic?.filePath).toContain("dynamic_workflow.json");
  });
});