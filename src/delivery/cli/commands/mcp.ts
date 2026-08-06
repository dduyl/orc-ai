import { DaemonServer } from "../../../application/harness/daemon/daemon-server.js";
import { log } from "../../../core/log.js";

/**
 * `orc mcp` — backward-compatible alias for the daemon block hosting MCP.
 *
 * Since D-2 (ADR-025), the canonical run host is `orc daemon start` (control
 * pipe + MCP + runs in one process). `orc mcp`'s historic behavior — an MCP
 * HTTP server on :3100 that lives until SIGINT — is exactly what a daemon
 * running with `mcp: { port }` provides, so this starts that same block. No
 * standalone MCP-only process remains.
 */
export async function startMcp(port = parseInt(process.env["MCP_PORT"] || "3100", 10)): Promise<void> {
  const daemon = new DaemonServer({ mcp: { port } });
  await daemon.start();

  process.on("SIGINT", () => {
    log.info("[MCP] Shutting down");
    void daemon.stop();
  });
  process.on("SIGTERM", () => {
    void daemon.stop();
  });
}