import { describe, it, expect } from "vitest";
import { loadYamlFile } from "../../../../application/planner/workflow-parser.js";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src", "workflows");

describe("builtin workflow script gates", () => {
  it("feat-impl-builtin parses with script gates and run expressions", () => {
    const w = loadYamlFile(join(ROOT, "feat-impl-builtin.yaml"));
    expect(w).not.toBeNull();
    const steps = w!.workflow.steps;
    const gates = steps.filter(s => s.type === "script");
    expect(gates.map(g => g.id).sort()).toEqual(["test_unit", "validate"]);
    expect(gates.every(g => g.run)).toBe(true);
    const validate = steps.find(s => s.id === "validate")!;
    expect(validate.run).toBe('cmd "validate"');
    expect(validate.signal?.signal_off).toBe("code");
    const testUnit = steps.find(s => s.id === "test_unit")!;
    expect(testUnit.run).toBe('cmd "test.unit"');
    expect(testUnit.signal?.signal_off).toBe("test");
    const reviewCode = steps.find(s => s.id === "review_code")!;
    expect(reviewCode.context).toContain("validate");
    const reviewTest = steps.find(s => s.id === "review_test")!;
    expect(reviewTest.context).toContain("test_unit");
    const testStep = steps.find(s => s.id === "test")!;
    expect(testStep.task).toContain("Generate tests");
    expect(testStep.task).not.toContain("report results");
  });

  it("bug-fix-builtin.yaml parses with a validate gate", () => {
    const w = loadYamlFile(join(ROOT, "bug-fix-builtin.yaml"));
    expect(w).not.toBeNull();
    const steps = w!.workflow.steps;
    const gates = steps.filter(s => s.type === "script");
    expect(gates.map(g => g.id)).toEqual(["validate"]);
    const validate = steps.find(s => s.id === "validate")!;
    expect(validate.run).toBe('cmd "validate"');
    expect(validate.signal?.signal_off).toBe("code");
    const reviewCode = steps.find(s => s.id === "review_code")!;
    expect(reviewCode.context).toContain("validate");
  });
});