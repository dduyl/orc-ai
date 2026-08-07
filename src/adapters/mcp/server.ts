import * as http from "node:http";
import type { RunHost } from "../../application/harness/run-host.js";
import { setAgentCwd } from "../../application/agents/adapter-pty.js";
import { McpHttpTransport, type McpSession } from "./http-transport.js";
import { createSdkServer } from "./sdk-server-factory.js";
import { init as initState } from "./handlers/state.js";

export class McpServer {
  private httpServer: http.Server | null = null;
  private sessions = new Map<string, McpSession>();
  private transport: McpHttpTransport;
  private host: RunHost;

  constructor(host: RunHost, onSessionChange?: (count: number) => void) {
    this.host = host;
    initState(host);
    if (host.projectDir) setAgentCwd(host.projectDir);
    this.transport = new McpHttpTransport(this.sessions, onSessionChange);
  }

  getHttpServer(): http.Server | null {
    return this.httpServer;
  }

  /**
   * Number of live MCP sessions (open Streamable-HTTP SSE clients). A
   * connected coding agent holds a session while its stream is open, so this
   * is how a daemon hosting MCP tells "an agent is attached to :3100" apart
   * from "idle". Used by the daemon's idle auto-exit gate.
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  async startHttp(port: number): Promise<void> {
    // setupInfrastructure + reconcileStaleRuns are owned by the hosting daemon
    // (DaemonServer.start()); McpServer is a pure HTTP transport.
    this.httpServer = await this.transport.listen(port, async (transport) => {
      const sdkServer = await createSdkServer(transport);
      return { transport, server: sdkServer, createdAt: Date.now() };
    });
  }
}