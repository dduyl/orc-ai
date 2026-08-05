import { McpServer } from "../../../adapters/mcp/server.js";
import { RunHost } from "../../../application/harness/run-host.js";
import { getAdapter, BUILTIN_ADAPTERS } from "../../../application/agents/adapter.js";
import { log } from "../../../core/log.js";

export async function startMcp(): Promise<void> {
  const portStr = process.env["MCP_PORT"] || "3100";
  const port = parseInt(portStr, 10);

  const adapter = getAdapter("opencode") ?? BUILTIN_ADAPTERS[0];
  const host = new RunHost(adapter, { projectDir: process.cwd() });
  const server = new McpServer(host);

  await server.startHttp(port);

  process.on("SIGINT", () => {
    log.info("[MCP] Shutting down");
    const httpServer = server.getHttpServer();
    if (httpServer) httpServer.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    const httpServer = server.getHttpServer();
    if (httpServer) httpServer.close();
    process.exit(0);
  });
}
