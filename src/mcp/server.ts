import * as http from "node:http";
import { setupInfrastructure } from "../harness/bootstrap.js";
import { WorkflowRegistry } from "../planner/registry.js";
import type { AdapterDef } from "../agents/adapter.js";
import { rpcOk, rpcError, type JsonRpcRequest, type JsonRpcResponse } from "./handlers/rpc.js";
import { log } from "../log.js";
import {
  handleInitialize,
  handleListTools,
  handleListResources,
  handleReadResource,
  handleListPrompts,
  handleGetPrompt,
  handleCancel,
} from "./handlers/capabilities.js";
import { handleToolCall as execToolCall, init as initToolExec } from "./handlers/tool-exec.js";
import { McpHttpTransport, type McpSession } from "./http-transport.js";
import { createSdkServer } from "./sdk-server-factory.js";

export { JsonRpcRequest, JsonRpcResponse };

export class McpServer {
  private handleToolCall = execToolCall;
  private httpServer: http.Server | null = null;
  private sessions = new Map<string, McpSession>();
  private transport = new McpHttpTransport(this.sessions);

  constructor(adapter: AdapterDef, registry?: WorkflowRegistry, onProgress?: (event: import("../harness/orchestrator/index.js").ProgressEvent) => void) {
    initToolExec(adapter, registry, onProgress);
  }

  getHttpServer(): http.Server | null {
    return this.httpServer;
  }

  async startHttp(port: number): Promise<void> {
    setupInfrastructure();

    this.httpServer = await this.transport.listen(port, async (transport) => {
      const sdkServer = await createSdkServer(transport, this.handleToolCall);
      return { transport, server: sdkServer, createdAt: Date.now() };
    });
  }

  private async handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    switch (req.method) {
      case "initialize":
        return handleInitialize(req.id, req.params);
      case "resources/list":
      case "listResources":
        return handleListResources(req.id, req.params);
      case "resources/read":
      case "readResource":
        return handleReadResource(req.id, req.params);
      case "prompts/list":
      case "listPrompts":
        return handleListPrompts(req.id, req.params);
      case "prompts/get":
      case "getPrompt":
        return handleGetPrompt(req.id, req.params);
      case "tools/list":
      case "listTools":
        return handleListTools(req.id, req.params);
      case "tools/call":
      case "callTool":
        return this.handleToolCall(req);
      case "notifications/initialized":
        return null;
      case "notifications/cancelled":
      case "$/cancelRequest":
        return handleCancel(req.id, req.params);
      default:
        if (req.id === undefined) return null;
        log.warn(`[MCP] Unknown method: ${req.method} (id=${req.id})`);
        return rpcError(req.id, -32601, "Method not found");
    }
  }
}
