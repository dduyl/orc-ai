import { Server } from "@modelcontextprotocol/sdk/server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import {
  CallToolRequestSchema,
  CallToolResult,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types";
import { ORC_INSTRUCTIONS } from "./handlers/content.js";
import {
  handleGetPrompt,
  handleListPrompts,
  handleListResources,
  handleListTools,
  handleReadResource,
} from "./handlers/capabilities.js";
import {
  handleCreateWorkflowTool,
  handleGetRunStatusTool,
  handleListRunsTool,
  handleListWorkflowsTool,
  handleRunWorkflow,
  type RunHandlerExtra,
} from "./handlers/workflow-handlers.js";
import { handleGuideTool, handleListPromptsTool, handleReturnResult } from "./handlers/result-handlers.js";
import { host } from "./handlers/state.js";
import { CodeGraphService } from "../../application/harness/graph/code-graph.js";

export type ToolHandler = (args: any, extra: RunHandlerExtra) => CallToolResult | Promise<CallToolResult>;

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  guide: (args) => handleGuideTool(args),
  list_workflows: () => handleListWorkflowsTool(),
  list_prompts: () => handleListPromptsTool(),
  create_workflow: (args) => handleCreateWorkflowTool(args),
  run_workflow: (args, extra) => handleRunWorkflow(args, extra),
  get_run_status: (args) => handleGetRunStatusTool(args),
  list_runs: () => handleListRunsTool(),
  return_result: (args) => handleReturnResult(args),
  code_graph_query: async (args) => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: args.queryType,
      target: args.target,
      depth: args.depth,
      projectDir: host.projectDir,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
};

export async function executeTool(name: string, args: any, extra: RunHandlerExtra): Promise<CallToolResult> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  return handler(args || {}, extra);
}

export async function createSdkServer(transport: StreamableHTTPServerTransport): Promise<Server> {
  const sdkServer = new Server(
    { name: "orc-server", version: "0.1.0" },
    {
      capabilities: { prompts: {}, tools: {}, resources: {} },
      instructions: ORC_INSTRUCTIONS,
    },
  );

  sdkServer.setRequestHandler(ListToolsRequestSchema, () => handleListTools());
  sdkServer.setRequestHandler(ListResourcesRequestSchema, () => handleListResources());
  sdkServer.setRequestHandler(ReadResourceRequestSchema, (req) => handleReadResource(req.params));
  sdkServer.setRequestHandler(ListPromptsRequestSchema, () => handleListPrompts());
  sdkServer.setRequestHandler(GetPromptRequestSchema, (req) => handleGetPrompt(req.params));
  sdkServer.setRequestHandler(CallToolRequestSchema, (req, extra) => executeTool(req.params.name, req.params.arguments, extra));

  await sdkServer.connect(transport);
  return sdkServer;
}