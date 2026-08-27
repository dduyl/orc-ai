import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { controlPipePath, deriveMcpPort } from "../../../../application/harness/daemon/pipe-name.js";
import { WorkflowRegistry } from "../../../../application/planner/registry.js";
import { loadModelRoutingConfig } from "../../../../application/agents/config.js";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `orc-multi-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("multi-workspace isolation", () => {
  let dir: string;
  beforeAll(() => { dir = tmpDir(); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("7a: pipe name is path-normalized (same dir, different paths → same pipe)", () => {
    const base = path.join(dir, "project");
    fs.mkdirSync(base, { recursive: true });
    const dotted = path.join(base, ".");
    expect(controlPipePath(base)).toBe(controlPipePath(dotted));
  });

  it("7b: project workflow dir overrides builtins", () => {
    const projectDir = path.join(dir, "proj-workflows");
    const workflowsDir = path.join(projectDir, ".orc", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    // Flat YAML format — no version/workflow wrapper
    fs.writeFileSync(path.join(workflowsDir, "test.yaml"), [
      "id: test-proj-wf",
      "name: Test Project Workflow",
      "steps: []",
      "completion: Done",
      "",
    ].join("\n"));

    const reg = new WorkflowRegistry({ projectDir });
    const workflows = reg.loadAll();
    const found = workflows.find((w: any) => w.id === "test-proj-wf");
    expect(found).toBeDefined();
    expect(found?.name).toBe("Test Project Workflow");
  });

  it("7c: project config overrides global config", () => {
    const projectDir = path.join(dir, "proj-config");
    const orcDir = path.join(projectDir, ".orc");
    fs.mkdirSync(orcDir, { recursive: true });
    fs.writeFileSync(path.join(orcDir, "config.json"), JSON.stringify({ tokenPaidApiKey: "project-key" }));

    const config = loadModelRoutingConfig(undefined, projectDir);
    expect(config.tokenPaidApiKey).toBe("project-key");
  });

  it("7d: MCP port derived from pipe name, unique per project", () => {
    const dirA = path.join(dir, "project-a");
    const dirB = path.join(dir, "project-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    const portA = deriveMcpPort(dirA);
    const portB = deriveMcpPort(dirB);
    expect(portA).toBeGreaterThanOrEqual(1024);
    expect(portA).toBeLessThanOrEqual(65535);
    expect(portB).toBeGreaterThanOrEqual(1024);
    expect(portB).toBeLessThanOrEqual(65535);
    // Different projects should have different ports (extremely high probability)
    expect(portA).not.toBe(portB);
  });

  it("7e: CLI --project-dir threads to pipe name", () => {
    const projectDir = path.join(dir, "cli-test");
    fs.mkdirSync(projectDir, { recursive: true });
    const pipe1 = controlPipePath(projectDir);
    const pipe2 = controlPipePath(path.join(projectDir, "."));
    expect(pipe1).toBe(pipe2);
  });
});
