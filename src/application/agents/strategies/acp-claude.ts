import type { AcpStrategy, AcpSpawnSpec } from "../acp/types.js";
import { probeBinary } from "../acp/resolve.js";

/**
 * Claude Code's ACP server via the external `claude-agent-acp` module.
 *
 * The plain `claude` CLI does not serve ACP over stdio; only the
 * `claude-agent-acp`/`zed` module does. When it's absent the adapter keeps
 * Claude on the PTY path (no ACP capability degradation). The bare command
 * name is resolved and `.cmd`-wrapped by cross-spawn at spawn time.
 */
export function createAcpClaude(): AcpStrategy {
  const available = probeBinary("claude-agent-acp", "claude");
  return {
    id: "claude",
    available,
    label: "claude-agent-acp",
    buildSpawn(_cwd: string): AcpSpawnSpec {
      return { command: "claude-agent-acp", args: [] };
    },
  };
}

export const acpClaudeStrategy: AcpStrategy = createAcpClaude();
