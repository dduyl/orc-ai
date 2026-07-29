import { McpServer } from "../../mcp/server.js";
import { WorkflowRegistry } from "../../planner/registry.js";
import { log } from "../../log.js";

export async function startMcp(): Promise<void> {
  const portStr = process.env["MCP_PORT"] || "3100";
  const port = parseInt(portStr, 10);

  const registry = new WorkflowRegistry();
  const server = new McpServer(
    { id: "opencode", command: "opencode", label: "OpenCode AI Code Orchestrator" },
    registry,
  );

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
