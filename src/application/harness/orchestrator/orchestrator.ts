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

export async function orchestrate(
  task: string,
  adapter: AdapterDef,
  plan: PlannerResult,
  resume?: boolean,
  tracker?: RunTracker,
  checkpointer?: Checkpointer,
  onProgress?: (event: ProgressEvent) => void,
  projectRoot?: string,
): Promise<RunReport> {
  const root = projectRoot ?? process.cwd();
  setupProject(root);
  const cp = checkpointer ?? new Checkpointer(path.join(root, ".orc", "checkpoints.sqlite"));

  let report: RunReport | undefined;
  try {
    const activeAdapter = adapter;
    const runId = tracker?.runId;

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
      });
    }

    const outcomes = await runWorkflow(
      plan.workflow.workflow.steps,
      handler,
      ctx,
      (step, outcome) => {
        allOutcomes.push(outcome);
        saveCheckpoint();
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
      const finalStatus = report.failed > 0 ? "failed" as const : "completed" as const;
      tracker.tracker.updateRunStatus(tracker.runId, finalStatus);
    }

    onProgress?.({ type: "workflow_complete", runId, status: report.failed > 0 ? "failed" : "completed", report });

    return report;
  } finally {
    if (report && report.failed === 0) {
      cp.prune(task);
    }
    cp.close();
  }
}
