import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkOwnership, DEFAULT_OWNERSHIP_RULES, loadOwnershipRules, deriveBranchName } from "../../../../application/harness/execution/worktree.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

  describe("loadOwnershipRules", () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-worktree-cfg-"));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns defaults when config file does not exist", () => {
      expect(loadOwnershipRules(tmpDir)).toEqual(DEFAULT_OWNERSHIP_RULES);
    });

    it("loads custom rules from .orc/worktrees.json", () => {
      const orcDir = path.join(tmpDir, ".orc");
      fs.mkdirSync(orcDir, { recursive: true });
      const customRules = { my_role: ["src/shared/**"] };
      fs.writeFileSync(path.join(orcDir, "worktrees.json"), JSON.stringify(customRules));
      expect(loadOwnershipRules(tmpDir)).toEqual(customRules);
    });

    it("returns defaults for malformed JSON", () => {
      const orcDir = path.join(tmpDir, ".orc");
      fs.mkdirSync(orcDir, { recursive: true });
      fs.writeFileSync(path.join(orcDir, "worktrees.json"), "{bad json!!!");
      expect(loadOwnershipRules(tmpDir)).toEqual(DEFAULT_OWNERSHIP_RULES);
    });
  });

  describe("deriveBranchName", () => {
    it("matches pattern orc/<8hex>/<stepId>-<timestamp>", () => {
      const name = deriveBranchName("/tmp/project-a", "codegen");
      expect(name).toMatch(/^orc\/[0-9a-f]{8}\/codegen-\d+$/);
    });

    it("produces different branches for different projects (same step)", () => {
      const a = deriveBranchName("/tmp/project-a", "codegen");
      const b = deriveBranchName("/tmp/project-b", "codegen");
      expect(a).not.toBe(b);
      // Same project hash prefix each time
      const hashA = a.split("/")[1];
      const hashB = b.split("/")[1];
      expect(hashA).not.toBe(hashB);
    });

    it("produces deterministic hash for same path", () => {
      const a = deriveBranchName("/tmp/project-a", "codegen");
      const b = deriveBranchName("/tmp/project-a", "codegen");
      // Hashes match (timestamps differ, but hash prefix is the same)
      expect(a.split("/")[1]).toBe(b.split("/")[1]);
    });
  });
});
