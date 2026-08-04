import { rpcOk, rpcError, type JsonRpcResponse } from "./rpc.js";
import { GUIDE_TEXT, ORC_INSTRUCTIONS } from "./content.js";
import { log } from "../../../core/log.js";

export function handleInitialize(id: number | string, params: any): JsonRpcResponse {
  const clientVersion = params?.protocolVersion || "2024-11-05";
  return rpcOk(id, {
    protocolVersion: clientVersion,
    capabilities: { prompts: {}, tools: {}, resources: {} },
    serverInfo: { name: "orc-server", version: "0.1.0" },
    instructions: ORC_INSTRUCTIONS,
  });
}

export function handleListTools(id: number | string, _params?: any): JsonRpcResponse {
  return rpcOk(id, {
    tools: [
      {
        name: "guide",
        description: "Read the ORC guide and optionally describe your task. Always call this first to understand available workflow types.",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "Optional task description" },
          },
        },
      },
      {
        name: "list_workflows",
        description: "MANDATORY first step. Call this before any other tool to see all registered workflows with descriptions and step summaries.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "list_prompts",
        description: "Call this BEFORE create_workflow. Lists valid agent names for workflow step definitions.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "create_workflow",
        description: "Call only when no existing workflow from list_workflows fits. Registers a new workflow \u2014 then run it with run_workflow.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique workflow ID used to reference it later" },
            name: { type: "string", description: "Human-readable name" },
            description: { type: "string", description: "What this workflow does and when to use it" },
            steps: {
              type: "array",
              description: "Signal-routed steps (ADR-011): each emits a fixed vocabulary and joins on `on` (ALL) or `any` (ANY) signal refs `stepId.signalName`; entry steps listen on __start__",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  agent: { type: "string", description: "Agent name from list_prompts (omit for `script` steps)" },
                  type: { type: "string", enum: ["agent", "script"], description: "Defaults to agent. `script` steps run a command group and emit emits[0] (exit 0) or emits[1] (non-zero)" },
                  run: { type: "string", description: "Script step run expression, e.g. `cmd \"validate\"`" },
                  emits: {
                    type: "array",
                    description: "Fixed output vocabulary — at least one { name, description }. Script steps: exactly 2 (positional pass/fail)",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        description: { type: "string" },
                      },
                      required: ["name", "description"],
                    },
                  },
                  on: { type: "array", items: { type: "string" }, description: "AND join: run when ALL these stepId.signalName signals fired. Exactly one of on/any required" },
                  any: { type: "array", items: { type: "string" }, description: "OR join: run when ANY of these stepId.signalName signals fires. Entry steps use [__start__]. Exactly one of on/any required" },
                  task: { type: "string" },
                  context: { type: "array", items: { type: "string" } },
                },
                required: ["id", "emits"],
              },
            },
            completion: { type: "string", description: "Completion message shown when workflow finishes" },
          },
          required: ["id", "name", "steps", "completion"],
        },
      },
      {
        name: "run_workflow",
        description: "Execute a registered workflow. Blocks until completion — progress is streamed via $/progress notifications in real-time.",
        inputSchema: {
          type: "object",
          properties: {
            workflowId: { type: "string", description: "Workflow ID from list_workflows" },
            task: { type: "string", description: "The task description to execute" },
            resume: { type: "boolean", description: "Resume a previous run" },
          },
          required: ["workflowId", "task"],
        },
      },
      {
        name: "get_run_status",
        description: "Get the current status of a workflow run by runId. Returns step-level progress, timing, and any errors.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string", description: "Run ID returned by run_workflow" },
          },
          required: ["runId"],
        },
      },
      {
        name: "list_runs",
        description: "List all workflow runs with summary status counts.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "return_result",
        description: "Report the structured result of a workflow step. Call this when your task is complete to provide a summary, artifact path, and affected files.",
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Summary of what was accomplished" },
            artifact: { type: "string", description: "Path to the generated artifact" },
            affectedFiles: { type: "array", items: { type: "string" }, description: "Files that were created or modified" },
            completionKey: { type: "string", description: "Opaque step completion key — include this verbatim when the prompt tells you to" },
            signal: { type: "string", description: "Signal NAME — must be exactly one of this step's `emits`. Only include when the prompt asks for it." },
          },
          required: ["summary"],
        },
      },
    ],
  });
}

export function handleListResources(id: number | string, _params?: any): JsonRpcResponse {
  return rpcOk(id, {
    resources: [{
      uri: "orc://guide",
      name: "ORC MCP Guide",
      description: "Instructions for using ORC MCP tools",
      mimeType: "text/markdown",
    }],
  });
}

export function handleReadResource(id: number | string, params: any): JsonRpcResponse {
  const uri = params?.uri || params?.resource || "";
  if (uri === "orc://guide") {
    return rpcOk(id, {
      contents: [{ uri: "orc://guide", mimeType: "text/markdown", text: GUIDE_TEXT }],
    });
  }
  return rpcError(id, -32602, `Unknown resource: ${uri}`);
}

export function handleListPrompts(id: number | string, _params?: any): JsonRpcResponse {
  return rpcOk(id, {
    prompts: [{
      name: "guide",
      description: "Read the ORC guide for using code generation workflows",
    }],
  });
}

export function handleGetPrompt(id: number | string, params: any): JsonRpcResponse {
  const name = params?.name || "";
  if (name === "guide") {
    return rpcOk(id, {
      description: "ORC Workflow Guide",
      messages: [{ role: "user", content: { type: "text", text: GUIDE_TEXT } }],
    });
  }
  return rpcError(id, -32602, `No prompt: ${name}`);
}

export function handleCancel(id: number | string | null, params?: any): null {
  const cancelledId = params?.requestId;
  log.info(`[MCP] Client cancelled request ${cancelledId} (${params?.reason || "no reason"})`);
  return null;
}
