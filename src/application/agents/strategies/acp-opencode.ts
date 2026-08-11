import type { AcpStrategy, AcpSpawnSpec } from "../acp/types.js";
import { findInPath, shellWrapIfNeeded } from "../acp/resolve.js";

/**
 * OpenCode's ACP server mode: `opencode acp --pure` over stdio.
 *
 * The binary is PATH-probed at registration; when missing the adapter falls
 * back to the PTY path. Best-effort: presence of the binary (not a version
 * check on the `acp` subcommand) is what we gate on.
 */
export function createAcpOpencode(): AcpStrategy {
  const resolved = findInPath("opencode");
  return {
    id: "opencode",
    available: Boolean(resolved),
    label: resolved ?? "opencode",
    buildSpawn(_cwd: string): AcpSpawnSpec {
      const cmd = resolved ?? "opencode";
      return shellWrapIfNeeded(cmd, ["acp", "--pure"]);
    },
  };
}

export const acpOpencodeStrategy: AcpStrategy = createAcpOpencode();