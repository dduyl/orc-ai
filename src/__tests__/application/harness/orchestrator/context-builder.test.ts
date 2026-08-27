import { describe, it, expect } from "vitest";
import { buildResponseInstructions, buildStepContext } from "../../../../application/harness/orchestrator/context-builder.js";
import type { WorkflowStep } from "../../../../core/schemas.js";

describe("harness/orchestrator/context-builder (ADR-024)", () => {
  it("includes concise summary instruction in response instructions (ADR-024)", () => {
    const step: WorkflowStep = {
      type: "agent",
      id: "code",
      agent: "code_generation_backend",
      task: "Generate code",
      context: [],
      emits: [{ name: "sig_done", description: "Done" }],
    };

    const instructions = buildResponseInstructions(step, "key-123");
    expect(instructions).toContain("ADR-024");
    expect(instructions).toContain("concise 1-2 sentence summary");
    expect(instructions).toContain("not a verbose narrative");
    expect(instructions).toContain('completionKey: "key-123"');
  });

  it("builds step context with concise instructions and ADR guidance", () => {
    const step: WorkflowStep = {
      type: "agent",
      id: "arch",
      agent: "arch",
      task: "Design architecture",
      context: [],
      emits: [{ name: "sig_done", description: "Done" }],
    };

    const context = buildStepContext(step, new Map());
    expect(context).toContain("=== Structural Code Graph (ADR-002) ===");
    expect(context).toContain("=== Bounded Research Budget (ADR-008) ===");
    expect(context).toContain("=== Human Escalation (ADR-016) ===");
    expect(context).toContain("ADR-024");
  });
});
