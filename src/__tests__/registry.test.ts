import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkflowRegistry } from "../planner/registry.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orc-reg-"));
}

const validWorkflow = {
  version: 1,
  workflow: {
    id: "test_workflow",
    name: "Test Workflow",
    steps: [{ id: "s1", agent: "requirement_analyst", task: "analyze", depends_on: [] }],
    completion: "All done",
  },
};

const defaultWorkflows: Record<string, object> = {
  feature_implementation: {
    version: 1,
    workflow: {
      id: "feature_implementation",
      name: "Feature Implementation",
      steps: [
        { id: "spec", agent: "requirement_analyst", task: "a", depends_on: [] },
        { id: "code", agent: "code_generation_backend", depends_on: ["spec"], task: "b" },
      ],
      completion: "Done",
    },
  },
  issue_to_fix: {
    version: 1,
    workflow: {
      id: "issue_to_fix",
      name: "Issue to Fix",
      steps: [{ id: "s1", agent: "requirement_analyst", task: "a", depends_on: [] }],
      completion: "Done",
    },
  },
  bugfix: {
    version: 1,
    workflow: {
      id: "bugfix",
      name: "Bugfix",
      steps: [{ id: "s1", agent: "requirement_analyst", task: "a", depends_on: [] }],
      completion: "Done",
    },
  },
};

function writeDefaults(dir: string) {
  for (const [name, def] of Object.entries(defaultWorkflows)) {
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(def));
  }
}

describe("WorkflowRegistry", () => {
  let dir: string;
  let reg: WorkflowRegistry;

  beforeEach(() => {
    dir = tmpDir();
    reg = new WorkflowRegistry(dir);
  });

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("loads file-based workflows", () => {
    fs.writeFileSync(path.join(dir, "custom.json"), JSON.stringify(validWorkflow));
    const loaded = reg.loadAll();
    const custom = loaded.find(w => w.id === "test_workflow");
    expect(custom).toBeDefined();
    expect(custom!.name).toBe("Test Workflow");
    expect(custom!.filePath).toContain("custom.json");
  });

  it("skips invalid JSON files and falls back to builtins", () => {
    fs.writeFileSync(path.join(dir, "bad.json"), "not json");
    const loaded = reg.loadAll();
    expect(loaded.find(w => w.filePath === "(builtin)")).toBeDefined();
    expect(loaded.length).toBeGreaterThanOrEqual(3);
  });

  it("skips files that fail schema validation", () => {
    fs.writeFileSync(path.join(dir, "invalid.json"), JSON.stringify({ version: 1, workflow: { id: "x" } }));
    const loaded = reg.loadAll();
    const invalid = loaded.find(w => w.id === "x");
    expect(invalid).toBeUndefined();
  });

  it("loads builtins when dir missing", () => {
    const r = new WorkflowRegistry(path.join(os.tmpdir(), "nonexistent-dir-" + Date.now()));
    const loaded = r.loadAll();
    expect(loaded.length).toBeGreaterThanOrEqual(3);
    expect(loaded.find(w => w.filePath === "(builtin)")).toBeDefined();
  });

  it("get returns workflow by id", () => {
    writeDefaults(dir);
    reg.loadAll();
    expect(reg.get("feature_implementation")).toBeDefined();
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  it("findByName matches by name or id", () => {
    writeDefaults(dir);
    reg.loadAll();
    expect(reg.findByName("Feature Implementation")).toBeDefined();
    expect(reg.findByName("feature_implementation")).toBeDefined();
    expect(reg.findByName("nope")).toBeUndefined();
  });
});
