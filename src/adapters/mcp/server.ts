import * as http from "node:http";
import { setupInfrastructure } from "../../application/harness/persistence/bootstrap.js";
import type { RunHost } from "../../application/harness/run-host.js";
import { reconcileStaleRuns } from "../../application/harness/start-run.js";
import { setAgentCwd } from "../../application/agents/adapter-pty.js";
import { McpHttpTransport, type McpSession } from "./http-transport.js";
import { createSdkServer } from "./sdk-server-factory.js";
import { init as initState } from "./handlers/state.js";

export class McpServer {
  private httpServer: http.Server | null = null;
  private sessions = new Map<string, McpSession>();
  private transport = new McpHttpTransport(this.sessions);
  private host: RunHost;

  constructor(host: RunHost) {
    this.host = host;
    initState(host);
    if (host.projectDir) setAgentCwd(host.projectDir);
  }

  getHttpServer(): http.Server | null {
    return this.httpServer;
  }

  async startHttp(port: number): Promise<void> {
    setupInfrastructure();
    // bgRuns is empty at startup, so any "running" row is an orphan from a
    // previous process — reconcile it so status queries are not stuck forever.
    reconcileStaleRuns(this.host);

    this.httpServer = await this.transport.listen(port, async (transport) => {
      const sdkServer = await createSdkServer(transport);
      return { transport, server: sdkServer, createdAt: Date.now() };
    });
  }
}