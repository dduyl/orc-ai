import { describe, it, expect } from "vitest";
import {
  checkResearchBudget,
  isResearchRole,
  MAX_RESEARCH_TOOL_CALLS,
} from "../../../../application/harness/execution/bounding.js";

describe("harness/execution/bounding-research (ADR-008)", () => {
  it("identifies research roles spec and arch", () => {
    expect(isResearchRole("spec")).toBe(true);
    expect(isResearchRole("arch")).toBe(true);
    expect(isResearchRole("code")).toBe(false);
    expect(isResearchRole("test")).toBe(false);
    expect(isResearchRole("review")).toBe(false);
  });

  it("permits research tool calls under MAX_RESEARCH_TOOL_CALLS for research roles", () => {
    expect(checkResearchBudget("spec", 0).ok).toBe(true);
    expect(checkResearchBudget("spec", 4).ok).toBe(true);
    expect(checkResearchBudget("arch", 3).ok).toBe(true);
  });

  it("fails budget check when research calls reach MAX_RESEARCH_TOOL_CALLS", () => {
    const check = checkResearchBudget("spec", MAX_RESEARCH_TOOL_CALLS);
    expect(check.ok).toBe(false);
    expect(check.error).toContain("Research tool-call budget exceeded");
    expect(check.error).toContain("unverified_assumption");
  });

  it("disallows open-ended research tool calls for non-research roles", () => {
    const check = checkResearchBudget("code", 1);
    expect(check.ok).toBe(false);
    expect(check.error).toContain("not permitted open-ended research tool calls");
  });
});
