import type { AdapterDef } from "../../agents/adapter.js";
import type { PlannerResult } from "../../planner/registry.js";
import { runWorkflow, type RunContext } from "../execution/step-runner.js";
import { Checkpointer, type StepResumeSnapshot } from "../persistence/Checkpointer.js";
import { StreamEmitter } from "../../../adapters/stream/emitter.js";
import { loadAgentSystemPrompts } from "../../planner/prompt-loader.js";
import { setupProject } from "../persistence/bootstrap.js";
import * as path from "node:path";
import { restoreSession } from "./resume.js";
import { createStepHandler } from "./step-handler.js";
import type { ProgressEvent, RunReport, RunTracker, StepSummary } from "./types.js";

export interface OrchestrateOptions {
  adapter: AdapterDef;
  plan: PlannerResult;
  resume?: boolean;
  tracker?: RunTracker;
  checkpointer?: Checkpointer;
  onProgress?: (event: ProgressEvent) => void;
  projectRoot?: string;
  signal?: AbortSignal;
}

export async function orchestrate(
  task: string,
  options: OrchestrateOptions,
): Promise<RunReport> {
  const { adapter, plan, resume, tracker, checkpointer, onProgress, projectRoot, signal } = options;
  const root = projectRoot ?? process.cwd();
  setupProject(root);
  const cp = checkpointer ?? new Checkpointer(path.join(root, ".orc", "checkpoints.sqlite"));
  // Hoisted: needed both by per-step checkpoint saves and the success prune in
  // `finally`. Runs are tracked per runId; "" when no tracker is supplied.
  const runId = tracker?.runId ?? "";

  let report: RunReport | undefined;
  try {
    const activeAdapter = adapter;

    const { sessionId, restoredStepResults } = restoreSession(task, resume, cp, tracker, onProgress);

    const agentPrompts = loadAgentSystemPrompts();
    const allOutcomes: import("../execution/step-runner.js").StepOutcome[] = [];
    const completedSummaries = new Map<string, StepSummary>();
    const emitter = new StreamEmitter();

    const handler = createStepHandler({
      adapter: activeAdapter,
      agentPrompts,
      completedSummaries,
      emitter,
      task,
      tracker,
      onProgress,
    });

    const ctx: RunContext = {
      workflowId: plan.workflow.workflow.id,
      stepResults: restoredStepResults,
      buildResults: new Map(),
      maxRetries: 2,
      repairFeedbacks: new Map(),
      signal,
    };

    function collectCheckpoint(): Record<string, StepResumeSnapshot> {
      const out: Record<string, StepResumeSnapshot> = {};
      for (const [stepId, o] of ctx.stepResults) {
        out[stepId] = { status: o.status, output: o.output, error: o.error, retries: o.retries, hooks: o.hooks };
      }
      return out;
    }

    function saveCheckpoint() {
      cp.save(task, {
        workflowId: plan.workflow.workflow.id,
        sessionId,
        agentId: activeAdapter.id,
        stepResults: collectCheckpoint(),
        context: { task },
      }, runId);
    }

    const outcomes = await runWorkflow(
      plan.workflow.workflow.steps,
      handler,
      ctx,
      (step, outcome) => {
        allOutcomes.push(outcome);
        saveCheckpoint();
        // Steps the runner fails without dispatching (abort tail in tryFinish,
        // upstream-failure cascade in propagateFailure) never ran through the
        // handler, so their tracker rows would otherwise stay "pending". This is
        // idempotent for steps the handler already marked.
        tracker?.tracker.setStepCompleted(tracker.runId, step.id, outcome.status, outcome.error);
      },
    );

    saveCheckpoint();

    report = {
      workflowId: plan.workflow.workflow.id,
      source: plan.source,
      outcomes,
      totalSteps: outcomes.length,
      completed: outcomes.filter(o => o.status === "completed").length,
      failed: outcomes.filter(o => o.status === "failed").length,
    };

    if (tracker) {
      const finalStatus = signal?.aborted
        ? "cancelled" as const
        : report.failed > 0 ? "failed" as const : "completed" as const;
      tracker.tracker.updateRunStatus(tracker.runId, finalStatus);
    }

    onProgress?.({ type: "workflow_complete", runId, status: signal?.aborted ? "cancelled" : report.failed > 0 ? "failed" : "completed", report });

    return report;
  } finally {
    if (report && report.failed === 0) {
      // Owner-scoped: only removes this run's own checkpoint, so a concurrent
      // same-task run's live row survives.
      cp.prune(task, runId);
    }
    cp.close();
  }
}
