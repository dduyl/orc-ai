import * as http from "node:http";
import * as crypto from "node:crypto";
import { setupInfrastructure } from "../harness/bootstrap.js";
import { WorkflowRegistry } from "../planner/registry.js";
import type { AdapterDef } from "../agents/adapter.js";
import { rpcOk, rpcError, type JsonRpcRequest, type JsonRpcResponse } from "./handlers/constants.js";
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
import { handleToolCall as execToolCall, handleRunWorkflowSdk, init as initToolExec } from "./handlers/tool-exec.js";
import { Server } from "@modelcontextprotocol/sdk/server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types";

export { JsonRpcRequest, JsonRpcResponse };

const ORC_INSTRUCTIONS = [
  "You are using ORC for code generation workflows. You MUST follow this exact sequence in order:",
  "",
  "1. list_workflows \u2014 always call this first to see registered workflows.",
  "2. list_prompts \u2014 always call this before create_workflow to see valid agent names.",
  "3. create_workflow \u2014 only when no workflow from step 1 fits your task.",
  "4. run_workflow \u2014 always use a workflowId from step 1 or step 3, never embed a workflow here.",
  "",
  "Rules:",
  "- Never embed a workflow definition inside run_workflow. Create it first, then run it.",
  "- Never guess a workflowId \u2014 always get it from list_workflows.",
  "- Agent names in step definitions must match list_prompts output exactly.",
  "- Root steps have depends_on: [].",
  "- If a registered workflow matches the task but you consider it too complex or token-heavy to run, you MUST NOT bypass it. Present both options (run workflow vs. implement directly) with brief tradeoffs and let the user decide.",
].join("\n");

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  createdAt: number;
}

export class McpServer {
  private handleToolCall = execToolCall;
  private httpServer: http.Server | null = null;
  private sessions = new Map<string, McpSession>();

  constructor(adapter: AdapterDef, registry?: WorkflowRegistry, onProgress?: (event: import("../harness/orchestrator.js").ProgressEvent) => void) {
    initToolExec(adapter, registry, onProgress);
  }

  getHttpServer(): http.Server | null {
    return this.httpServer;
  }

  async startHttp(port: number): Promise<void> {
    setupInfrastructure();

    const server = http.createServer(async (req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      const sessionId = this.getSessionId(req);

      try {
        if (sessionId) {
          const session = this.sessions.get(sessionId);
          if (!session) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          await session.transport.handleRequest(req, res);
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });

        const sdkServer = await this.createSdkServer(transport);
        await transport.handleRequest(req, res);
        const newId = transport.sessionId;
        if (newId) {
          const entry: McpSession = { transport, server: sdkServer, createdAt: Date.now() };
          this.sessions.set(newId, entry);
          transport.onclose = () => {
            this.sessions.delete(newId);
          };
        }
      } catch (err: any) {
        log.warn(`[MCP] HTTP error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });

    this.httpServer = server;
    return new Promise<void>(resolve => {
      server.listen(port, "0.0.0.0", () => {
        log.info(`[MCP] HTTP Streamable server on http://0.0.0.0:${port}`);
        resolve();
      });
    });
  }

  private getSessionId(req: http.IncomingMessage): string | null {
    const header = req.headers["mcp-session-id"] as string
      ?? req.headers["mcpsessionid"] as string;
    if (header) return header;
    const cookie = req.headers.cookie;
    if (cookie) {
      for (const c of cookie.split(";")) {
        const [k, v] = c.trim().split("=");
        if (k.toLowerCase() === "mcpsessionid") return v;
      }
    }
    return null;
  }

  private async createSdkServer(transport: StreamableHTTPServerTransport): Promise<Server> {
    const sdkServer = new Server(
      { name: "orc-server", version: "0.1.0" },
      {
        capabilities: { prompts: {}, tools: {}, resources: {} },
        instructions: ORC_INSTRUCTIONS,
      },
    );

    sdkServer.setRequestHandler(ListToolsRequestSchema, async () => {
      const resp = handleListTools("sdk" as any);
      return resp.result as any;
    });

    sdkServer.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resp = handleListResources("sdk" as any);
      return resp.result as any;
    });

    sdkServer.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const resp = handleReadResource("sdk" as any, req.params as any);
      return resp.result as any;
    });

    sdkServer.setRequestHandler(ListPromptsRequestSchema, async () => {
      const resp = handleListPrompts("sdk" as any);
      return resp.result as any;
    });

    sdkServer.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const resp = handleGetPrompt("sdk" as any, req.params as any);
      return resp.result as any;
    });

    sdkServer.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const { name, arguments: args } = req.params;

      if (name === "run_workflow") {
        return await handleRunWorkflowSdk(args || {}, { ...extra, _meta: req.params._meta } as any);
      }

      const jrpcReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: "sdk",
        method: "tools/call",
        params: { name, arguments: args } as any,
      };
      const resp = await execToolCall(jrpcReq);
      return resp.result as any;
    });

    await sdkServer.connect(transport);
    return sdkServer;
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
