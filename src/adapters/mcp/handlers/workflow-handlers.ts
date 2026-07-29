import { rpcOk, rpcError } from "./rpc.js";
import type { JsonRpcResponse } from "./rpc.js";
import type { PlannerResult } from "../../../application/planner/registry.js";
import { orchestrate, type ProgressEvent, type RunReport, type RunTracker } from "../../../application/harness/orchestrator/index.js";
import { Checkpointer } from "../../../application/harness/persistence/Checkpointer.js";
import { WorkflowDefinition } from "../../../core/schemas.js";
import { hasPtyWriter, notifyMainPty } from "../../../application/harness/signalling/pty-notifier.js";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { log } from "../../../core/log.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types";
import { adapter, registry, tracker, onProgress, bgRuns, projectDir as stateProjectDir } from "./state.js";
import { getValidAgentNames, buildCompletionPrompt } from "./formatting.js";

export function handleListWorkflowsTool(id: number | string): JsonRpcResponse {
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
  return rpcOk(id, {
    content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
  });
}

export function handleCreateWorkflowTool(id: number | string, args: any): JsonRpcResponse {
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

  registry.loadAll();
  const existing = registry.get(args.id);
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
  registry.saveDynamic(parsed);

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

export async function handleRunWorkflowSdk(
  args: any,
  extra: { sendNotification: (n: any) => Promise<void>; _meta?: { progressToken?: any }; signal: AbortSignal },
): Promise<{ content: { type: string; text: string }[] }> {
  const task = args?.task as string;
  const workflowId = args?.workflowId as string;

  if (!task) throw new McpError(ErrorCode.InvalidParams, "Missing 'task' argument");
  if (!workflowId) throw new McpError(ErrorCode.InvalidParams, "Missing 'workflowId' argument");

  registry.loadAll();
  const found = registry.get(workflowId);
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
  tracker.createRun(runId, plan.workflow.workflow.id, workflowName, task, adapter.id, stepEntries);

  const runTracker: RunTracker = { runId, tracker };
  const rootDir = stateProjectDir ?? process.cwd();
  const checkpointer = new Checkpointer(path.join(rootDir, ".orc", "checkpoints.sqlite"));

  // Fire orchestrate() in the background — do NOT await here.
  // This lets run_workflow return immediately, avoiding the client-side timeout.
  const bgPromise = orchestrate(task, adapter, plan, resume, runTracker, checkpointer, (event: ProgressEvent) => {
    onProgress?.(event);

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
    bgRuns.delete(runId);
    log.info(`[run ${runId}] Workflow "${workflowId}" completed: ${report.completed}/${report.totalSteps} completed`);
    notifyMainPty(buildCompletionPrompt(runId, workflowName, report));
    return report;
  }).catch((err: any) => {
    bgRuns.delete(runId);
    log.warn(`[run ${runId}] Workflow "${workflowId}" failed: ${err.message}`);
    try { tracker.updateRunStatus(runId, "failed"); } catch {}
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

  bgRuns.set(runId, bgPromise);

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

export async function handleRunWorkflowTool(id: number | string, args: any): Promise<JsonRpcResponse> {
  const task = args?.task as string;
  const workflowId = args?.workflowId as string;

  if (!task) return rpcError(id, -32602, "Missing 'task' argument");
  if (!workflowId) return rpcError(id, -32602, "Missing 'workflowId' argument");

  registry.loadAll();
  const found = registry.get(workflowId);
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

  tracker.createRun(runId, plan.workflow.workflow.id, workflowName, task, adapter.id, stepEntries);

  const runTracker: RunTracker = { runId, tracker };
  const rootDir = stateProjectDir ?? process.cwd();
  const checkpointer = new Checkpointer(path.join(rootDir, ".orc", "checkpoints.sqlite"));

  // Fire in background — same pattern as handleRunWorkflowSdk.
  const bgPromise = orchestrate(task, adapter, plan, resume, runTracker, checkpointer)
    .then((report) => {
      bgRuns.delete(runId);
      log.info(`[run ${runId}] Workflow "${workflowId}" completed: ${report.completed}/${report.totalSteps} completed`);
      notifyMainPty(buildCompletionPrompt(runId, workflowName, report));
      return report;
    })
    .catch((err: any) => {
      bgRuns.delete(runId);
      log.warn(`[run ${runId}] Workflow "${workflowId}" failed: ${err.message}`);
      try { tracker.updateRunStatus(runId, "failed"); } catch {}
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

  bgRuns.set(runId, bgPromise);

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

export async function handleGetRunStatusTool(id: number | string, args: any): Promise<JsonRpcResponse> {
  const runId = args?.runId as string;
  if (!runId) return rpcError(id, -32602, "Missing 'runId' argument");

  let run = tracker.getRun(runId);
  if (!run) return rpcError(id, -32602, `Unknown runId: ${runId}`);

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

export function handleListRunsTool(id: number | string): JsonRpcResponse {
  const runs = tracker.listRuns();
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
