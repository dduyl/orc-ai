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

type Row = { label: string; steps: any[]; ok: boolean; message?: string[] };

// Branch-coverage matrix for validateCreateWorkflowSteps: one entry per
// acceptance/rejection branch, each against the real validator.
const MATRIX: Row[] = [
  { label: "empty step list", steps: [], ok: true },
  { label: "valid agent step", steps: [agentStep()], ok: true },
  { label: "valid script step (F2: no agent needed)", steps: [scriptStep()], ok: true },
  { label: "mixed agent + script steps", steps: [agentStep(), scriptStep()], ok: true },
  { label: "script missing run", steps: [scriptStep("gate", { run: undefined })], ok: false, message: ["run"] },
  { label: "script run empty string", steps: [scriptStep("gate", { run: "   " })], ok: false, message: ["run"] },
  { label: "script run non-string", steps: [scriptStep("gate", { run: 42 })], ok: false, message: ["run"] },
  { label: "script with 1 emit", steps: [scriptStep("gate", { emits: [{ name: "x", description: "d" }] })], ok: false, message: ["2 'emits'"] },
  { label: "script with 3 emits", steps: [scriptStep("gate", { emits: [{ name: "a", description: "d" }, { name: "b", description: "d" }, { name: "c", description: "d" }] })], ok: false, message: ["2 'emits'"] },
  { label: "script with non-array emits", steps: [scriptStep("gate", { emits: "nope" })], ok: false, message: ["2 'emits'"] },
  { label: "step with no type / no agent", steps: [{ id: "x", emits: [{ name: "d", description: "d" }] }], ok: false, message: ["agent"] },
  { label: "agent step empty agent", steps: [{ id: "x", type: "agent", agent: "  ", emits: [{ name: "d", description: "d" }] }], ok: false, message: ["agent"] },
  { label: "agent step unknown agent", steps: [{ ...agentStep(), agent: "nope" }], ok: false, message: ["unknown agent"] },
  { label: "null step entry", steps: [(agentStep() as any) && null], ok: false, message: ["agent"] },
  { label: "middle step error is reported by id", steps: [agentStep("first"), scriptStep("gate", { emits: [{ name: "x", description: "d" }] }), agentStep("third")], ok: false, message: ['"gate"', "2 'emits'"] },
  { label: "empty id falls back to positional label", steps: [agentStep(), scriptStep("", { run: undefined })], ok: false, message: ["#2", "run"] },
];

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

  it.each(MATRIX.map((r) => [r.label, r] as const))(
    "matrix: %s",
    (_label: string, row: Row) => {
      const msg = validateCreateWorkflowSteps(row.steps, AGENTS);
      if (row.ok) {
        expect(msg).toBeNull();
      } else {
        expect(msg).toBeTruthy();
        for (const fragment of row.message ?? []) {
          expect(msg!).toContain(fragment);
        }
      }
    },
  );
});