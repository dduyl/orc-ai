import { describe, it, expect } from "vitest";
import { checkOwnership, DEFAULT_OWNERSHIP_RULES } from "../../../../application/harness/execution/worktree.js";

describe("harness/execution/worktree (ADR-015)", () => {
  it("allows backend agent to modify backend and core files", () => {
    const result = checkOwnership("code_generation_backend", [
      "src/application/agents/adapter.ts",
      "src/core/types.ts",
      "src/adapters/mcp/server.ts",
    ]);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects violations when backend agent modifies frontend GUI files", () => {
    const result = checkOwnership("code_generation_backend", [
      "src/application/agents/adapter.ts",
      "src/delivery/gui/renderer.ts",
      "src/delivery/gui/index.html",
    ]);
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("src/delivery/gui/renderer.ts");
    expect(result.violations).toContain("src/delivery/gui/index.html");
  });

  it("allows frontend agent to modify delivery GUI files", () => {
    const result = checkOwnership("code_generation_frontend", [
      "src/delivery/gui/chat-view.ts",
      "src/delivery/gui/index.html",
    ]);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("allows unconstrained roles without ownership rules", () => {
    const result = checkOwnership("requirement_analyst", [
      "docs/specs/feature.md",
      "README.md",
    ]);
    expect(result.valid).toBe(true);
  });
});
