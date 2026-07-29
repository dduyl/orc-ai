import { rpcError } from "./rpc.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./rpc.js";
import { log } from "../../../core/log.js";
import { init } from "./state.js";
import { handleGuideTool, handleListPromptsTool, handleReturnResult } from "./result-handlers.js";
import {
  handleListWorkflowsTool,
  handleCreateWorkflowTool,
  handleRunWorkflowTool,
  handleRunWorkflowSdk,
  handleGetRunStatusTool,
  handleListRunsTool,
} from "./workflow-handlers.js";

export { init, handleRunWorkflowSdk };

export async function handleToolCall(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const params = req.params || {};
  const toolName = params.name as string || params.tool as string;
  const args = (params.arguments as any) || (params.args as any) || {};

  try {
    if (toolName === "guide") return handleGuideTool(req.id, args);
    if (toolName === "list_workflows") return handleListWorkflowsTool(req.id);
    if (toolName === "list_prompts") return handleListPromptsTool(req.id);
    if (toolName === "create_workflow") return handleCreateWorkflowTool(req.id, args);
    if (toolName === "run_workflow") return await handleRunWorkflowTool(req.id, args);
    if (toolName === "get_run_status") return await handleGetRunStatusTool(req.id, args);
    if (toolName === "list_runs") return handleListRunsTool(req.id);
    if (toolName === "return_result") return handleReturnResult(req.id, args);

    log.warn(`[MCP] Unknown tool: ${toolName} (id=${req.id})`);
    return rpcError(req.id, -32601, `Unknown tool: ${toolName}`);
  } catch (err: any) {
    log.warn(`[MCP] Tool call error: ${toolName} (id=${req.id}): ${err.message}`);
    if (err.stack) log.warn(err.stack);
    return rpcError(req.id, -32603, err.message);
  }
}
