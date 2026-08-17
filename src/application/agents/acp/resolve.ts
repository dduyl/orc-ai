import { log } from "../../../core/log.js";
import which from "which";

/**
 * Probe whether a command is runnable from PATH without launching an agent.
 * Used to decide whether an adapter id routes through ACP or stays on the PTY
 * path. Resolution follows the platform's real rules (PATHEXT on Windows, so
 * un-executable bare shims like npm's extensionless `opencode` are skipped).
 */
export function probeBinary(name: string, logHint: string): boolean {
  const resolved = which.sync(name, { nothrow: true });
  if (resolved) {
    log.debug(`acp: ${logHint} resolved '${name}' -> ${resolved}`);
    return true;
  }
  return false;
}
