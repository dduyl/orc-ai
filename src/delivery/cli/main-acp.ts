import { getAcpStrategy } from "../../application/agents/strategy.js";
import type { PermissionRequest } from "../../application/agents/acp/permission.js";
import { MainAcpSession } from "../../application/harness/daemon/main-acp-session.js";
import { loadDotEnv } from "./env-loader.js";

/**
 * Spawn the daemon-owned persistent ACP main session (ADR-026 Phase 3).
 *
 * `orc daemon start --main acp` replaces the interactive PTY main terminal
 * with one long-lived ACP agent session. The session is the user's persistent
 * coding agent: the GUI attaches to the main pipe for structured `MainFrame`s
 * and drives it over the control pipe (`prompt` / `cancelMain` /
 * `answerPermission`). Permission requests are wired to the daemon, which
 * broadcasts them on the control pipe for the attached GUI to answer.
 */
export function spawnMainAcpSession(
  adapterId: string,
  opts: { onPermission: (request: PermissionRequest) => void; cwd?: string },
): MainAcpSession {
  loadDotEnv(opts.cwd);
  const strat = getAcpStrategy(adapterId);
  if (!strat || !strat.available) {
    throw new Error(
      `ACP main session requires an ACP-capable adapter ('${adapterId}' is unavailable)`,
    );
  }
  const cwd = opts.cwd ?? process.cwd();
  return new MainAcpSession({
    cwd,
    spawn: strat.buildSpawn(cwd),
    env: { ...(process.env as Record<string, string>) },
    onPermission: opts.onPermission,
  });
}
