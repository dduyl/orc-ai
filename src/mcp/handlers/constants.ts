export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export function rpcOk(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export const GUIDE_TEXT = `# ORC Workflow Guide

## Mandatory flow
1. list_workflows — see what's registered
2. list_prompts — see valid agent names before creating a workflow
3. create_workflow — only when no existing workflow fits
4. run_workflow — execute by workflowId

## Rules
- Never embed a workflow definition in run_workflow
- create_workflow → run_workflow (always two separate calls)
- Agent names must match list_prompts output exactly
- Root steps have depends_on: []
- If a registered workflow matches the task but you consider it too complex or token-heavy to run, you MUST NOT bypass it. Present both options (run workflow vs. implement directly) with brief tradeoffs and let the user decide.

## Step field reference
| Field | Required | Description |
|-------|----------|-------------|
| id | yes | Unique step ID |
| agent | yes | Name from list_prompts |
| depends_on | yes | [] for root, ["stepId"] for dependents |
| task | no | What this step does |
| context | no | Step IDs whose output to inject |
| signal | no | name + description + optional signal_on/signal_off — agent-decided quality signal. true routes to signal_on; false routes to signal_off with cascade reset |

## Failure modes
| Error | Fix |
|-------|-----|
| Unknown agent: X | Call list_prompts, use a valid name |
| Unknown workflowId: X | Call list_workflows for valid IDs |
| Missing 'task' argument | Add a task string to run_workflow |
`;

export const BUILTIN_PROMPTS = [
  { name: "requirement_analyst", description: "Analyzes requirements and produces structured specification artifacts" },
  { name: "architecture_agent", description: "Designs architecture, generates ADRs and contract definitions" },
  { name: "code_generation_backend", description: "Generates backend source code from specifications and architecture" },
  { name: "code_generation_frontend", description: "Generates frontend source code from specifications and design" },
  { name: "test_generation_backend", description: "Generates backend unit and integration tests" },
  { name: "test_generation_frontend", description: "Generates frontend component and integration tests" },
  { name: "review", description: "Reviews any artifact type and provides scored feedback" },
];
