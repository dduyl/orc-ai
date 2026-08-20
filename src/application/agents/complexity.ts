import { execFile } from "node:child_process";

/**
 * Model-routing complexity signal (ADR-021). A deterministic, cheap signal
 * derived from workspace state — never an LLM judgment call.
 */
export type Complexity = "complex" | "simple";

/**
 * Threshold: a step touching this many changed files (inclusive) is routed to
 * the strong variant. Boundary decision: `changedFiles >= COMPLEX_CHANGED_FILES`
 * is complex.
 */
export const COMPLEX_CHANGED_FILES = 8;

/** Snapshot of the workspace state the complexity classifier routes on. */
export interface RepoState {
  /** Count of changed files (tracked + untracked) vs the base commit. */
  changedFiles: number;
}

/** Injectable process runner; defaults to `git status --porcelain`. */
export type Exec = (
  command: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; code: number }>;

const defaultExec: Exec = (command, args, opts) =>
  new Promise(resolve => {
    execFile(command, args, { cwd: opts.cwd }, (err, stdout) => {
      if (err) {
        // Spawn failure (git missing) vs non-zero exit are both "no state".
        const code = typeof err.code === "number" ? err.code : -1;
        resolve({ stdout: "", code });
        return;
      }
      resolve({ stdout: String(stdout), code: 0 });
    });
  });

/**
 * Read the workspace state from git porcelain output. Returns `undefined`
 * when git is unavailable, the directory is not a repository, or the call
 * fails — the caller routes conservatively ("complex") in that case.
 */
export async function readRepoState(
  projectRoot: string,
  exec: Exec = defaultExec,
): Promise<RepoState | undefined> {
  try {
    const { stdout, code } = await exec("git", ["status", "--porcelain"], { cwd: projectRoot });
    if (code !== 0) return undefined;
    const changedFiles = stdout.split("\n").filter(line => line.trim().length > 0).length;
    return { changedFiles };
  } catch {
    return undefined;
  }
}

/**
 * Classify a step as complex or simple for model routing (ADR-021). The task
 * text is carried for future classifier inputs; today the signal is purely the
 * workspace diff. No repo state available -> "complex" (never under-provision).
 */
export function classifyComplexity(task: string, repoState: RepoState | undefined): Complexity {
  if (!repoState) return "complex";
  return repoState.changedFiles >= COMPLEX_CHANGED_FILES ? "complex" : "simple";
}