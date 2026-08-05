import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Derive the daemon's named-pipe paths (ADR-025 Phase C, locked design #3).
 *
 * Naming is per-project deterministic: the control pipe is derived from a hash
 * of `projectDir`, so two processes that share a project compute the SAME name
 * and therefore talk to the SAME daemon — at most one daemon may bind a name
 * (bind fails if taken). `--pipe` / `ORC_PIPE` override the base. Terminal
 * pipes for each run derive from the same base so a client can compute them
 * without a pointer/handshake file.
 *
 * win32 uses `\\.\pipe\orc-agent-<hash>`; POSIX falls back to an AF_UNIX socket
 * under the temp dir.
 */

function hashKey(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Base string shared by both the control and the per-run terminal pipes. */
function pipeBase(projectDir?: string, override?: string): string {
  if (override) {
    // An override is a full control pipe path; strip a POSIX `.sock` so the
    // terminal name derives cleanly from the same base.
    return override.replace(/\.sock$/, "");
  }
  const key = hashKey(projectDir ?? process.cwd());
  return process.platform === "win32"
    ? `\\\\.\\pipe\\orc-agent-${key}`
    : path.join(os.tmpdir(), `orc-agent-${key}`);
}

export function controlPipePath(projectDir?: string, override?: string): string {
  const base = pipeBase(projectDir, override);
  return process.platform === "win32" ? base : `${base}.sock`;
}

/** Terminal pipe for a specific run. Fire-and-forget byte channel. */
export function terminalPipePath(projectDir: string | undefined, runId: string, override?: string): string {
  const base = pipeBase(projectDir, override);
  return process.platform === "win32" ? `${base}-term-${runId}` : `${base}-term-${runId}.sock`;
}