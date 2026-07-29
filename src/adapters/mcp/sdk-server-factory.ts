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
import type { JsonRpcRequest, JsonRpcResponse } from "./handlers/rpc.js";
import { ORC_INSTRUCTIONS } from "./handlers/content.js";
import {
  handleListTools,
  handleListResources,
  handleReadResource,
  handleListPrompts,
  handleGetPrompt,
} from "./handlers/capabilities.js";
import { handleToolCall as execToolCall, handleRunWorkflowSdk } from "./handlers/tool-exec.js";

export async function createSdkServer(
  transport: StreamableHTTPServerTransport,
  onToolCall: (req: JsonRpcRequest) => Promise<JsonRpcResponse>,
): Promise<Server> {
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
    const resp = await onToolCall(jrpcReq);
    return resp.result as any;
  });

  await sdkServer.connect(transport);
  return sdkServer;
}
