import { spawn, type IPty } from "node-pty";
import type { PtyLike } from "../../application/harness/daemon/terminal-store.js";
import { loadDotEnv } from "./env-loader.js";

/**
 * Spawn the daemon-owned main interactive PTY (Phase D D-3).
 *
 * The coding agent's own opencode shell runs here, tagged `__main__` by the
 * daemon and served on the main-terminal pipe. The run host reaches per-step
 * coding agents over MCP instead; so that agent (and tools) can also find the
 * hosted MCP server, `ORC_MCP_ENDPOINT` is set to the daemon's :3100 endpoint.
 *
 * Returns a `PtyLike` so the framework-agnostic daemon never imports node-pty.
 */
export function spawnMainPty(
  adapterId: string,
  opts: { cwd?: string; mcpPort?: number } = {},
): PtyLike {
  loadDotEnv(opts.cwd);

  const cmd = adapterId === "opencode"
    ? "opencode"
    : adapterId === "antigravity"
    ? "agy"
    : `npx ${adapterId}`;
  const shell = process.platform === "win32"
    ? (process.env.COMSPEC || "cmd.exe")
    : cmd;
  const args: string[] = process.platform === "win32" ? ["/k", cmd] : [];

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.mcpPort != null) {
    env["ORC_MCP_ENDPOINT"] = `http://127.0.0.1:${opts.mcpPort}`;
  }

  const pty = spawn(shell, args, {
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    cwd: opts.cwd ?? process.cwd(),
    env,
  });

  return pty as IPty as unknown as PtyLike;
}