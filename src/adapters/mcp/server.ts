import * as http from "node:http";
import { setupInfrastructure } from "../../application/harness/persistence/bootstrap.js";
import type { RunHost } from "../../application/harness/run-host.js";
import { setAgentCwd } from "../../application/agents/adapter-pty.js";
import { McpHttpTransport, type McpSession } from "./http-transport.js";
import { createSdkServer } from "./sdk-server-factory.js";
import { init as initState } from "./handlers/state.js";

export class McpServer {
  private httpServer: http.Server | null = null;
  private sessions = new Map<string, McpSession>();
  private transport = new McpHttpTransport(this.sessions);

  constructor(host: RunHost) {
    initState(host);
    if (host.projectDir) setAgentCwd(host.projectDir);
  }

  getHttpServer(): http.Server | null {
    return this.httpServer;
  }

  async startHttp(port: number): Promise<void> {
    setupInfrastructure();

    this.httpServer = await this.transport.listen(port, async (transport) => {
      const sdkServer = await createSdkServer(transport);
      return { transport, server: sdkServer, createdAt: Date.now() };
    });
  }
}