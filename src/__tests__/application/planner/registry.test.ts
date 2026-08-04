import { describe, it, expect } from "vitest";
import { WorkflowRegistry } from "../../../application/planner/registry.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("WorkflowRegistry", () => {
  it("loads workflows from dir", () => {
    const tmpDir = path.join(os.tmpdir(), `orc-reg-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const wfJson = {
      version: 1,
      workflow: {
        id: "wf-custom",
        name: "Custom Workflow",
        steps: [{ id: "step1", agent: "analyst", emits: [{ name: "done", description: "done" }], on: ["__start__"] }],
        completion: "Done",
      },
    };
    fs.writeFileSync(path.join(tmpDir, "custom.json"), JSON.stringify(wfJson));

    const reg = new WorkflowRegistry({ userDir: tmpDir, builtinDir: tmpDir });
    reg.loadAll();
    expect(reg.get("wf-custom")).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
