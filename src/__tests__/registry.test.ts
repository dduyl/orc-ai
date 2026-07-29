import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkflowRegistry } from "../planner/registry.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { dump as dumpYaml } from "js-yaml";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orc-reg-"));
}

const yamlWorkflow = {
  id: "test_workflow",
  name: "Test Workflow",
  steps: [{ id: "s1", agent: "requirement_analyst", needs: [], task: "analyze" }],
  completion: "All done",
};

const defaultWorkflows: Record<string, object> = {
  feature_implementation: {
    id: "feature_implementation",
    name: "Feature Implementation",
    steps: [
      { id: "spec", agent: "requirement_analyst", needs: [], task: "a" },
      { id: "code", agent: "code_generation_backend", needs: ["spec"], task: "b" },
    ],
    completion: "Done",
  },
  issue_to_fix: {
    id: "issue_to_fix",
    name: "Issue to Fix",
    steps: [{ id: "s1", agent: "requirement_analyst", needs: [], task: "a" }],
    completion: "Done",
  },
  bugfix: {
    id: "bugfix",
    name: "Bugfix",
    steps: [{ id: "s1", agent: "requirement_analyst", needs: [], task: "a" }],
    completion: "Done",
  },
};

function writeDefaults(dir: string) {
  for (const [name, def] of Object.entries(defaultWorkflows)) {
    fs.writeFileSync(path.join(dir, `${name}.yaml`), dumpYaml(def));
  }
}

describe("WorkflowRegistry", () => {
  let dir: string;
  let reg: WorkflowRegistry;

  beforeEach(() => {
    dir = tmpDir();
    reg = new WorkflowRegistry({ userDir: dir });
  });

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("loads YAML-based workflows", () => {
    fs.writeFileSync(path.join(dir, "custom.yaml"), dumpYaml(yamlWorkflow));
    const loaded = reg.loadAll();
    const custom = loaded.find(w => w.id === "test_workflow");
    expect(custom).toBeDefined();
    expect(custom!.name).toBe("Test Workflow");
    expect(custom!.filePath).toContain("custom.yaml");
  });

  it("loads JSON workflows for backward compat", () => {
    fs.writeFileSync(path.join(dir, "custom.json"), JSON.stringify({
      version: 1,
      workflow: {
        id: "json_workflow",
        name: "JSON Workflow",
        steps: [{ id: "s1", agent: "requirement_analyst", task: "analyze", depends_on: [] }],
        completion: "All done",
      },
    }));
    const loaded = reg.loadAll();
    expect(loaded.find(w => w.id === "json_workflow")).toBeDefined();
  });

  it("loads both builtins and user workflows simultaneously", () => {
    fs.writeFileSync(path.join(dir, "custom.yaml"), dumpYaml(yamlWorkflow));
    const loaded = reg.loadAll();
    expect(loaded.find(w => w.id === "test_workflow")).toBeDefined();
    expect(loaded.find(w => w.filePath === "(builtin)")).toBeDefined();
  });

  it("skips invalid YAML files and preserves builtins", () => {
    fs.writeFileSync(path.join(dir, "bad.yaml"), "{{ not yaml");
    const loaded = reg.loadAll();
    expect(loaded.find(w => w.filePath === "(builtin)")).toBeDefined();
    expect(loaded.length).toBeGreaterThanOrEqual(2);
  });

  it("skips files that fail schema validation", () => {
    fs.writeFileSync(path.join(dir, "invalid.yaml"), dumpYaml({ id: "x", name: "X", steps: [{ id: "s1", needs: [] }] }));
    // Missing completion → schema fails
    const loaded = reg.loadAll();
    const invalid = loaded.find(w => w.id === "x");
    expect(invalid).toBeUndefined();
  });

  it("loads builtins when dir missing", () => {
    const r = new WorkflowRegistry({ userDir: path.join(os.tmpdir(), "nonexistent-dir-" + Date.now()) });
    const loaded = r.loadAll();
    expect(loaded.length).toBeGreaterThanOrEqual(2);
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
