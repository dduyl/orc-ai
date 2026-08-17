import type { AcpStrategy, AcpSpawnSpec } from "../acp/types.js";
import { findInPath, shellWrapIfNeeded } from "../acp/resolve.js";

/**
 * Claude Code's ACP server via the external `claude-agent-acp` module.
 *
 * The plain `claude` CLI does not serve ACP over stdio; only the
 * `claude-agent-acp`/`zed` module does. When it's absent the adapter keeps
 * Claude on the PTY path (no ACP capability degradation).
 */
export function createAcpClaude(): AcpStrategy {
  const resolved = findInPath("claude-agent-acp");
  return {
    id: "claude",
    available: Boolean(resolved),
    label: resolved ?? "claude-agent-acp",
    buildSpawn(_cwd: string): AcpSpawnSpec {
      const cmd = resolved ?? "claude-agent-acp";
      return shellWrapIfNeeded(cmd, []);
    },
  };
}

export const acpClaudeStrategy: AcpStrategy = createAcpClaude();