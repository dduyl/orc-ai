import { WorkflowDefinition, validateWorkflowGraph } from "../../../core/schemas.js";
import { CallToolResult, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types";
import { startRun } from "../../../application/harness/start-run.js";
import { hasPtyWriter } from "../../../application/harness/signalling/pty-notifier.js";
import { host, registry, tracker, bgRuns } from "./state.js";
import { getValidAgentNames } from "./formatting.js";
import { validateCreateWorkflowSteps } from "./workflow-validation.js";

/**
 * Structural subset of the SDK's CallTool `extra` consumed by run_workflow.
 * `sendNotification`/`signal`/`_meta.progressToken` are what the SDK provides
 * on the request handler; kept structural since `RequestHandlerExtra` is not
 * part of the SDK's public type surface.
 */
export interface RunHandlerExtra {
  sendNotification: (notification: any) => Promise<void>;
  _meta?: { progressToken?: string | number };
  signal: AbortSignal;
}

export function handleListWorkflowsTool(): CallToolResult {
  registry.loadAll();
  const list = registry.list().map(w => ({
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
  return {
    content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
  };
}

export function handleCreateWorkflowTool(args: any): CallToolResult {
  if (!args.id || !args.name || !args.steps || !args.completion) {
    throw new McpError(ErrorCode.InvalidParams, "Missing required fields: id, name, steps, completion");
  }

  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, "Steps must be a non-empty array");
  }

  const validAgents = getValidAgentNames();

  const stepErr = validateCreateWorkflowSteps(args.steps, validAgents);
  if (stepErr) {
    throw new McpError(ErrorCode.InvalidParams, stepErr);
  }

  registry.loadAll();
  const existing = registry.get(args.id);
  if (existing) {
    throw new McpError(ErrorCode.InvalidParams, `Workflow ID "${args.id}" already exists. Use a different ID.`);
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

  // F12: an unresolvable signal graph must be rejected here, not at run time.
  const graphIssues = validateWorkflowGraph(parsed);
  if (graphIssues.length > 0) {
    throw new McpError(ErrorCode.InvalidParams, `Workflow "${args.id}" fails signal graph validation: ${graphIssues.map(i => i.message).join("; ")}`);
  }

  registry.saveDynamic(parsed);

  return {
    content: [{ type: "text", text: JSON.stringify({
      id: parsed.workflow.id,
      name: parsed.workflow.name,
      description: parsed.workflow.description || "",
      steps: parsed.workflow.steps.length,
      status: "created",
      _next: `run_workflow(workflowId="${parsed.workflow.id}", task="<describe what to do>")`,
    }, null, 2) }],
  };
}

export async function handleRunWorkflow(args: any, extra: RunHandlerExtra): Promise<CallToolResult> {
  const task = args?.task as string;
  const workflowId = args?.workflowId as string;

  if (!task) throw new McpError(ErrorCode.InvalidParams, "Missing 'task' argument");
  if (!workflowId) throw new McpError(ErrorCode.InvalidParams, "Missing 'workflowId' argument");

  registry.loadAll();
  const found = registry.get(workflowId);
  if (!found) throw new McpError(ErrorCode.InvalidParams, `Unknown workflowId: ${workflowId}`);

  const stepEntries = found.definition.workflow.steps.map((s: any) => ({
    stepId: s.id,
    agent: s.agent || null,
    task: s.task || null,
    signals: [...(s.on || []), ...(s.any || [])],
  }));
  const totalSteps = stepEntries.length;
  const resume = args?.resume === true;

  const run = await startRun(host, task, workflowId, resume, {
    onEvent: (event) => {
      if (event.type === "step_pty") return;

      const progress = event.type === "step_start" || event.type === "step_complete"
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
    },
  });

  return {
    content: [{ type: "text", text: JSON.stringify(run, null, 2) }],
  };
}

export async function handleGetRunStatusTool(args: any): Promise<CallToolResult> {
  const runId = args?.runId as string;
  if (!runId) throw new McpError(ErrorCode.InvalidParams, "Missing 'runId' argument");

  let run = tracker.getRun(runId);
  if (!run) throw new McpError(ErrorCode.InvalidParams, `Unknown runId: ${runId}`);

  // Headless fallback: when there is no PTY to push notifications into,
  // block here until the background run finishes so the caller gets a
  // definitive answer on the first (and only) status check.
  if (!hasPtyWriter() && run.status === "running") {
    const pending = bgRuns.get(runId);
    if (pending) {
      try { await pending; } catch { /* error already logged & stored */ }
      run = tracker.getRun(runId) ?? run;
    }
  }

  return {
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
        signals: s.signals,
      })),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
    }, null, 2) }],
  };
}

export function handleListRunsTool(): CallToolResult {
  const runs = tracker.listRuns();
  return {
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
  };
}