import { describe, it, expect } from "vitest";
import { validateCreateWorkflowSteps } from "../../../../adapters/mcp/handlers/workflow-validation.js";

const AGENTS = new Set(["codegen", "review", "analyst"]);

const agentStep = (id = "code") => ({ id, type: "agent", agent: "codegen", emits: [{ name: "done", description: "d" }], on: ["__start__"] });
const scriptStep = (id = "validate", overrides: any = {}) => ({
  id,
  type: "script",
  run: 'cmd "validate"',
  emits: [{ name: "sig_pass", description: "d" }, { name: "sig_fail", description: "d" }],
  on: ["__start__"],
  ...overrides,
});

describe("validateCreateWorkflowSteps", () => {
  it("accepts an agent step", () => {
    expect(validateCreateWorkflowSteps([agentStep()], AGENTS)).toBeNull();
  });

  it("accepts a script step without an agent (F2)", () => {
    expect(validateCreateWorkflowSteps([scriptStep()], AGENTS)).toBeNull();
  });

  it("rejects a step with no agent and no script type", () => {
    const msg = validateCreateWorkflowSteps([{ id: "x", emits: [{ name: "done", description: "d" }] }], AGENTS);
    expect(msg).toBeTruthy();
    expect(msg).toContain("agent");
  });

  it("rejects a script step missing a run expression", () => {
    const msg = validateCreateWorkflowSteps([scriptStep("gate", { run: undefined })], AGENTS);
    expect(msg).toContain("run");
  });

  it("rejects a script step without exactly 2 emits", () => {
    const msg = validateCreateWorkflowSteps([scriptStep("gate", { emits: [{ name: "x", description: "d" }] })], AGENTS);
    expect(msg).toContain("2 'emits'");
  });

  it("rejects an unknown agent name on an agent step", () => {
    const msg = validateCreateWorkflowSteps([{ ...agentStep(), agent: "nope" }], AGENTS);
    expect(msg).toContain("unknown agent");
  });
});