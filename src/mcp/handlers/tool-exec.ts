import { rpcOk, rpcError, GUIDE_TEXT, BUILTIN_PROMPTS, type JsonRpcRequest, type JsonRpcResponse } from "./constants.js";
import type { PlannerResult } from "../../planner/registry.js";
import { WorkflowRegistry } from "../../planner/registry.js";
import { orchestrate, type ProgressEvent, type RunReport } from "../../harness/orchestrator.js";
import { RunStore } from "../../harness/RunStore.js";
import { setupProject } from "../../harness/bootstrap.js";
import type { AdapterDef } from "../../agents/adapter.js";
import { WorkflowDefinition } from "../../schemas.js";
import { loadAgentSystemPrompts, loadAgentPrompts } from "../../planner/prompt-loader.js";
import { hasPtyWriter, notifyMainPty } from "../../harness/pty-notifier.js";
import { resolveCompletion } from "../../harness/StepCompletionRegistry.js";
import * as crypto from "node:crypto";
import { log } from "../../log.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types";

let _registry: WorkflowRegistry;
let _adapter: AdapterDef;
let _runStore: RunStore;
let _onProgress: ((event: ProgressEvent) => void) | undefined;

/**
 * Keeps background orchestrate() Promises referenced so they are not
 * garbage-collected before they resolve.  Also used by get_run_status
 * to await completion in headless (no-PTY) mode.
 */
const _bgRuns = new Map<string, Promise<RunReport>>();

export function init(adapter: AdapterDef, registry?: WorkflowRegistry, onProgress?: (event: ProgressEvent) => void) {
  _adapter = adapter;
  _registry = registry || new WorkflowRegistry();
  _runStore = new RunStore();
  _onProgress = onProgress;
}

function getValidAgentNames(): Set<string> {
  const prompts = loadAgentSystemPrompts();
  if (prompts.size > 0) return new Set(prompts.keys());
  return new Set(BUILTIN_PROMPTS.map(a => a.name));
}

function handleGuideTool(id: number | string, args: any): JsonRpcResponse {
  setupProject();
  const task = (args?.task as string || "").trim();
  let text = GUIDE_TEXT;
  if (task) text += `\n\n## User Task\n\n${task}`;
  return rpcOk(id, {
    content: [{ type: "text", text }],
  });
}

function handleListWorkflowsTool(id: number | string): JsonRpcResponse {
  _registry.loadAll();
  const list = _registry.list().map(w => ({
    id: w.id,
    name: w.name,
    description: w.definition.workflow.description || "",
    steps: w.definition.workflow.steps.map(s => ({
      id: s.id,
      agent: s.agent || null,
      task: s.task || null,
    })),
    completion: w.definition.workflow.completion,
  }));
  return rpcOk(id, {
    content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
  });
}

function handleListPromptsTool(id: number | string): JsonRpcResponse {
  const fromPrompts = loadAgentPrompts();
  const prompts = fromPrompts.length > 0 ? fromPrompts : BUILTIN_PROMPTS;
  return rpcOk(id, {
    content: [{ type: "text", text: JSON.stringify(prompts, null, 2) }],
  });
}

function handleCreateWorkflowTool(id: number | string, args: any): JsonRpcResponse {
  if (!args.id || !args.name || !args.steps || !args.completion) {
    return rpcError(id, -32602, "Missing required fields: id, name, steps, completion");
  }

  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    return rpcError(id, -32602, "Steps must be a non-empty array");
  }

  const validAgents = getValidAgentNames();

  for (let i = 0; i < args.steps.length; i++) {
    const s = args.steps[i];
    if (!s.agent) {
      return rpcError(id, -32602, `Step "${s.id}": "agent" field is required`);
    }
    if (!validAgents.has(s.agent)) {
      return rpcError(id, -32602, `Step "${s.id}": unknown agent "${s.agent}". Use list_prompts to see valid names.`);
    }
  }

  _registry.loadAll();
  const existing = _registry.get(args.id);
  if (existing) {
    return rpcError(id, -32602, `Workflow ID "${args.id}" already exists. Use a different ID.`);
  }

  const definition = {
    version: 1,
    workflow: {
      id: args.id,
      name: args.name,
      description: args.description || "",
      steps: args.steps,
      completion: args.completion,
    },
  };

  const parsed = WorkflowDefinition.parse(definition);
  _registry.saveDynamic(parsed);

  return rpcOk(id, {
    content: [{ type: "text", text: JSON.stringify({
      id: parsed.workflow.id,
      name: parsed.workflow.name,
      description: parsed.workflow.description || "",
      steps: parsed.workflow.steps.length,
      status: "created",
      _next: `run_workflow(workflowId="${parsed.workflow.id}", task="<describe what to do>")`,
    }, null, 2) }],
  });
}

function buildResultPayload(runId: string, workflowId: string, workflowName: string, report: RunReport) {
  return {
    runId,
    workflowId,
    workflowName,
    status: report.failed > 0 ? "failed" : "completed",
    report,
  };
}

/**
 * Formats the [ORC] completion notification that gets pushed into the
 * opencode PTY (or returned by get_run_status in headless mode).
 */
function buildCompletionPrompt(runId: string, workflowName: string, report: RunReport): string {
  const overallStatus = report.failed > 0 ? "FAILED" : "COMPLETED";
  const lines: string[] = [
    `[ORC] Workflow "${workflowName}" ${overallStatus} (runId: ${runId})`,
    `Status: ${report.completed}/${report.totalSteps} steps completed`,
    "",
    "=== Step Results ===",
    "",
  ];

  for (const o of report.outcomes) {
    lines.push(`[${o.stepId}] — ${o.status.toUpperCase()}`);
    if (o.summary) lines.push(`  Summary  : ${o.summary}`);
    if (o.artifact) lines.push(`  Artifact : ${o.artifact}`);
    if (o.affectedFiles?.length) lines.push(`  Files    : ${o.affectedFiles.join(", ")}`);
    if (o.error) lines.push(`  Error    : ${o.error}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("Goal check: Review the step results above.");
  lines.push("  • If the goal is met      → call orc_return_result with your summary.");
  lines.push("  • If the goal is NOT met  → call run_workflow with the remaining task.");

  return lines.join("\n");
}

export async function handleRunWorkflowSdk(
  args: any,
  extra: { sendNotification: (n: any) => Promise<void>; _meta?: { progressToken?: any }; signal: AbortSignal },
): Promise<{ content: { type: string; text: string }[] }> {
  const task = args?.task as string;
  const workflowId = args?.workflowId as string;

  if (!task) throw new McpError(ErrorCode.InvalidParams, "Missing 'task' argument");
  if (!workflowId) throw new McpError(ErrorCode.InvalidParams, "Missing 'workflowId' argument");

  _registry.loadAll();
  const found = _registry.get(workflowId);
  if (!found) throw new McpError(ErrorCode.InvalidParams, `Unknown workflowId: ${workflowId}`);

  const resume = args?.resume === true;
  const plan: PlannerResult = { workflow: found.definition, source: "registered", registration: found };
  const runId = crypto.randomUUID();
  const workflowName = plan.workflow.workflow.name;

  const stepEntries = plan.workflow.workflow.steps.map((s: any) => ({
    stepId: s.id,
    agent: s.agent || null,
    task: s.task || null,
    dependsOn: s.depends_on || [],
  }));

  const totalSteps = stepEntries.length;
  _runStore.createRun(runId, plan.workflow.workflow.id, workflowName, task, _adapter.id, stepEntries);

  // Fire orchestrate() in the background — do NOT await here.
  // This lets run_workflow return immediately, avoiding the client-side timeout.
  const bgPromise = orchestrate(task, _adapter, plan, resume, runId, _runStore, (event: ProgressEvent) => {
    _onProgress?.(event);

    if (event.type === "step_pty") return;

    const progress = event.type === "step_start"
      ? stepEntries.findIndex((s: any) => s.stepId === event.stepId) + 1
      : event.type === "step_complete"
        ? stepEntries.findIndex((s: any) => s.stepId === event.stepId) + 1
        : totalSteps;
    const message = event.type === "step_start"
      ? `Starting: ${event.agent || event.stepId}`
      : event.type === "step_complete"
        ? `Step ${event.stepId}: ${event.status}${event.error ? ` — ${event.error}` : ""}`
        : event.type === "workflow_complete"
          ? `Workflow: ${event.status}`
          : `Error: ${event.error || "unknown"}`;

    extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: extra._meta?.progressToken,
        progress,
        total: totalSteps,
        message,
      },
    }).catch(() => {});
  }).then((report) => {
    _bgRuns.delete(runId);
    log.info(`[run ${runId}] Workflow "${workflowId}" completed: ${report.completed}/${report.totalSteps} completed`);
    notifyMainPty(buildCompletionPrompt(runId, workflowName, report));
    return report;
  }).catch((err: any) => {
    _bgRuns.delete(runId);
    log.warn(`[run ${runId}] Workflow "${workflowId}" failed: ${err.message}`);
    try { _runStore.updateRunStatus(runId, "failed"); } catch {}
    // Still notify the PTY so opencode knows the run failed.
    const failReport: RunReport = {
      workflowId,
      source: plan.source,
      outcomes: [],
      totalSteps,
      completed: 0,
      failed: totalSteps,
    };
    notifyMainPty(buildCompletionPrompt(runId, workflowName, failReport));
    throw err;
  });

  _bgRuns.set(runId, bgPromise);

  return {
    content: [{ type: "text", text: JSON.stringify({
      runId,
      workflowId,
      workflowName,
      status: "running",
      message: hasPtyWriter()
        ? "Workflow started in background. You will be notified via the terminal when it completes."
        : "Workflow started in background. Call get_run_status with this runId to check progress.",
    }, null, 2) }],
  };
}

async function handleRunWorkflowTool(id: number | string, args: any): Promise<JsonRpcResponse> {
  const task = args?.task as string;
  const workflowId = args?.workflowId as string;

  if (!task) return rpcError(id, -32602, "Missing 'task' argument");
  if (!workflowId) return rpcError(id, -32602, "Missing 'workflowId' argument");

  _registry.loadAll();
  const found = _registry.get(workflowId);
  if (!found) return rpcError(id, -32602, `Unknown workflowId: ${workflowId}`);

  const resume = args?.resume === true;
  const plan: PlannerResult = { workflow: found.definition, source: "registered", registration: found };
  const runId = crypto.randomUUID();
  const workflowName = plan.workflow.workflow.name;

  const stepEntries = plan.workflow.workflow.steps.map((s: any) => ({
    stepId: s.id,
    agent: s.agent || null,
    task: s.task || null,
    dependsOn: s.depends_on || [],
  }));

  _runStore.createRun(runId, plan.workflow.workflow.id, workflowName, task, _adapter.id, stepEntries);

  // Fire in background — same pattern as handleRunWorkflowSdk.
  const bgPromise = orchestrate(task, _adapter, plan, resume, runId, _runStore)
    .then((report) => {
      _bgRuns.delete(runId);
      log.info(`[run ${runId}] Workflow "${workflowId}" completed: ${report.completed}/${report.totalSteps} completed`);
      notifyMainPty(buildCompletionPrompt(runId, workflowName, report));
      return report;
    })
    .catch((err: any) => {
      _bgRuns.delete(runId);
      log.warn(`[run ${runId}] Workflow "${workflowId}" failed: ${err.message}`);
      try { _runStore.updateRunStatus(runId, "failed"); } catch {}
      const failReport: RunReport = {
        workflowId,
        source: plan.source,
        outcomes: [],
        totalSteps: stepEntries.length,
        completed: 0,
        failed: stepEntries.length,
      };
      notifyMainPty(buildCompletionPrompt(runId, workflowName, failReport));
      throw err;
    });

  _bgRuns.set(runId, bgPromise);

  return rpcOk(id, {
    content: [{ type: "text", text: JSON.stringify({
      runId,
      workflowId,
      workflowName,
      status: "running",
      message: hasPtyWriter()
        ? "Workflow started in background. You will be notified via the terminal when it completes."
        : "Workflow started in background. Call get_run_status with this runId to check progress.",
    }, null, 2) }],
  });
}

async function handleGetRunStatusTool(id: number | string, args: any): Promise<JsonRpcResponse> {
  const runId = args?.runId as string;
  if (!runId) return rpcError(id, -32602, "Missing 'runId' argument");

  let run = _runStore.getRun(runId);
  if (!run) return rpcError(id, -32602, `Unknown runId: ${runId}`);

  // Headless fallback: when there is no PTY to push notifications into,
  // block here until the background run finishes so the caller gets a
  // definitive answer on the first (and only) status check.
  if (!hasPtyWriter() && run.status === "running") {
    const pending = _bgRuns.get(runId);
    if (pending) {
      try { await pending; } catch { /* error already logged & stored */ }
      run = _runStore.getRun(runId) ?? run;
    }
  }

  return rpcOk(id, {
    content: [{ type: "text", text: JSON.stringify({
      runId: run.runId,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      task: run.task,
      adapterId: run.adapterId,
      status: run.status,
      currentStepId: run.currentStepId,
      steps: run.steps.map(s => ({
        stepId: s.stepId,
        agent: s.agent,
        task: s.task,
        status: s.status,
        duration: s.duration,
        error: s.error,
        dependsOn: s.dependsOn,
      })),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
    }, null, 2) }],
  });
}

function handleListRunsTool(id: number | string): JsonRpcResponse {
  const runs = _runStore.listRuns();
  return rpcOk(id, {
    content: [{ type: "text", text: JSON.stringify(runs.map(r => ({
      runId: r.runId,
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      status: r.status,
      stepsTotal: r.steps.length,
      stepsCompleted: r.steps.filter(s => s.status === "completed").length,
      stepsFailed: r.steps.filter(s => s.status === "failed").length,
      stepsRunning: r.steps.filter(s => s.status === "running").length,
      stepsPending: r.steps.filter(s => s.status === "pending").length,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      completedAt: r.completedAt,
    })), null, 2) }],
  });
}

function handleReturnResult(id: number | string, args: any): JsonRpcResponse {
  const summary = args?.summary || "(no summary)";
  const artifact = args?.artifact || "";
  const affectedFiles = args?.affectedFiles || [];
  const completionKey = args?.completionKey as string | undefined;
  log.info(`[return_result] summary="${summary}" artifact="${artifact}" files=${JSON.stringify(affectedFiles)}${completionKey ? ` key=${completionKey}` : ""}`);
  if (completionKey) {
    resolveCompletion(completionKey, { summary, artifact, affectedFiles });
  }
  return rpcOk(id, { status: "ok", message: "Result recorded." });
}

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
