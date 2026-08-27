import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as crypto from "node:crypto";
import { log } from "../../../core/log.js";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
}

export interface MergeResult {
  success: boolean;
  conflicts?: string[];
  output?: string;
}

export interface OwnershipCheckResult {
  valid: boolean;
  violations: string[];
}

export const DEFAULT_OWNERSHIP_RULES: Record<string, string[]> = {
  code_generation_backend: ["src/application", "src/core", "src/adapters", "src/backend", "src/__tests__/application", "src/__tests__/adapters", "src/__tests__/core"],
  backend: ["src/application", "src/core", "src/adapters", "src/backend", "src/__tests__/application", "src/__tests__/adapters", "src/__tests__/core"],
  code_generation_frontend: ["src/delivery/gui", "src/delivery/tui", "src/frontend", "src/__tests__/delivery"],
  frontend: ["src/delivery/gui", "src/delivery/tui", "src/frontend", "src/__tests__/delivery"],
  test_generation_backend: ["src/__tests__", "src/workflows"],
  test_generation_frontend: ["src/__tests__/delivery", "src/workflows"],
};

/**
 * Load ownership rules from `<projectDir>/.orc/worktrees.json`. Falls back to
 * `DEFAULT_OWNERSHIP_RULES` when the config file is missing or unparseable.
 */
export function loadOwnershipRules(projectDir: string): Record<string, string[]> {
  const configPath = join(projectDir, ".orc", "worktrees.json");
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string[]>;
      }
    }
  } catch {
    // Corrupted or unreadable config → fall back to defaults.
  }
  return DEFAULT_OWNERSHIP_RULES;
}

/**
 * Derive a short, deterministic project hash from the project directory path.
 * Used to namespace branches per-project and avoid collisions across projects.
 */
function projectHash(projectDir: string): string {
  return crypto.createHash("sha256").update(projectDir).digest("hex").slice(0, 8);
}

/**
 * Derive a project-namespaced branch name for a worktree step.
 * Format: `orc/<projectHash>/<stepId>-<timestamp>`
 */
export function deriveBranchName(projectDir: string, stepId: string): string {
  return `orc/${projectHash(projectDir)}/${stepId}-${Date.now()}`;
}

export class WorktreeManager {
  /**
   * Create an isolated Git worktree for parallel step execution (ADR-015).
   */
  static createWorktree(
    projectDir: string,
    stepId: string,
    baseCommit?: string,
  ): WorktreeInfo {
    const worktreesDir = join(projectDir, ".orc", "worktrees");
    if (!existsSync(worktreesDir)) {
      mkdirSync(worktreesDir, { recursive: true });
    }

    const branch = deriveBranchName(projectDir, stepId);
    const worktreePath = join(worktreesDir, stepId);

    // Clean up existing worktree path if present
    if (existsSync(worktreePath)) {
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, { cwd: projectDir, stdio: "ignore" });
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    const base = baseCommit ? ` "${baseCommit}"` : "";
    execSync(`git worktree add -b "${branch}" "${worktreePath}"${base}`, {
      cwd: projectDir,
      stdio: "pipe",
    });

    log.info(`[worktree] Created isolated worktree for step '${stepId}' at ${worktreePath} (branch: ${branch})`);
    return { worktreePath, branch };
  }

  /**
   * Remove and clean up an existing Git worktree.
   */
  static removeWorktree(projectDir: string, worktreePath: string, deleteBranch?: string): void {
    try {
      if (existsSync(worktreePath)) {
        execSync(`git worktree remove --force "${worktreePath}"`, {
          cwd: projectDir,
          stdio: "ignore",
        });
      }
    } catch {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {}
    }

    if (deleteBranch) {
      try {
        execSync(`git branch -D "${deleteBranch}"`, { cwd: projectDir, stdio: "ignore" });
      } catch {}
    }
  }

  /**
   * Merge an isolated worktree branch back into the current active branch.
   */
  static mergeWorktree(projectDir: string, branch: string): MergeResult {
    try {
      const output = execSync(`git merge --no-ff "${branch}" -m "chore(orc): merge parallel worktree ${branch}"`, {
        cwd: projectDir,
        encoding: "utf-8",
      });
      return { success: true, output };
    } catch (err: any) {
      const stderr = err?.stderr?.toString() || err?.message || "";
      const stdout = err?.stdout?.toString() || "";
      const full = stdout + "\n" + stderr;

      const conflicts = full
        .split("\n")
        .filter(l => l.includes("CONFLICT"))
        .map(l => l.trim());

      log.warn(`[worktree] Merge conflict when merging '${branch}': ${conflicts.join("; ")}`);
      return { success: false, conflicts, output: full };
    }
  }

  /**
   * Roll back uncommitted changes or reset a specific worktree.
   */
  static rollbackWorktree(worktreePath: string): void {
    if (!existsSync(worktreePath)) return;
    try {
      execSync("git reset --hard HEAD", { cwd: worktreePath, stdio: "ignore" });
      execSync("git clean -fd", { cwd: worktreePath, stdio: "ignore" });
      log.info(`[worktree] Rolled back changes in worktree at ${worktreePath}`);
    } catch (err) {
      log.warn(`[worktree] Failed to rollback worktree: ${err}`);
    }
  }
}

/**
 * Check if the affected files modified by an agent step respect that role's ownership boundaries (ADR-015).
 */
export function checkOwnership(
  role: string,
  affectedFiles: string[],
  customRules?: Record<string, string[]>,
): OwnershipCheckResult {
  const normalizedRole = role.toLowerCase();
  const rules = customRules ?? DEFAULT_OWNERSHIP_RULES;
  const allowedPrefixes = rules[normalizedRole];

  // If no specific ownership boundaries are configured for this role, all files are permitted
  if (!allowedPrefixes || allowedPrefixes.length === 0) {
    return { valid: true, violations: [] };
  }

  const violations: string[] = [];
  for (const file of affectedFiles) {
    const normalizedPath = file.replace(/\\/g, "/").replace(/^\.\//, "");
    const isAllowed = allowedPrefixes.some(prefix => {
      const normPrefix = prefix.replace(/\\/g, "/").replace(/\/\*\*$/, "").replace(/\/$/, "");
      return normalizedPath.startsWith(normPrefix);
    });

    if (!isAllowed) {
      violations.push(file);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
