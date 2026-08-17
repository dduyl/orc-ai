import type { AcpStrategy, AcpSpawnSpec } from "../acp/types.js";
import { probeBinary } from "../acp/resolve.js";

/**
 * OpenCode's ACP server mode: `opencode acp --pure` over stdio.
 *
 * The binary is PATH-probed at registration; when missing the adapter falls
 * back to the PTY path. Best-effort: presence of the binary (not a version
 * check on the `acp` subcommand) is what we gate on. The bare command name is
 * resolved and `.cmd`-wrapped by cross-spawn at spawn time, so Windows npm
 * shims (`opencode.cmd`) work without any hand-rolled resolution.
 */
export function createAcpOpencode(): AcpStrategy {
  const available = probeBinary("opencode", "opencode");
  return {
    id: "opencode",
    available,
    label: "opencode",
    buildSpawn(_cwd: string): AcpSpawnSpec {
      return { command: "opencode", args: ["acp", "--pure"] };
    },
  };
}

export const acpOpencodeStrategy: AcpStrategy = createAcpOpencode();
