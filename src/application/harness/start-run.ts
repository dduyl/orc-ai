import * as crypto from "node:crypto";
import * as path from "node:path";
import type { RunHost } from "./run-host.js";
import type { PlannerResult, RegisteredWorkflow } from "../planner/registry.js";
import { orchestrate, type ProgressEvent, type RunReport, type RunTracker } from "./orchestrator/index.js";
import { Checkpointer } from "./persistence/Checkpointer.js";
import { hasPtyWriter, notifyMainPty } from "./signalling/pty-notifier.js";
import { buildCompletionPrompt } from "./completion.js";
import { log } from "../../core/log.js";

export interface StartRunOptions {
  /** Transport-specific observer (e.g. SDK progress notifications). Optional. */
  onEvent?: (event: ProgressEvent) => void;
  /**
   * Pre-resolved registration from a caller that already loaded the registry
   * (e.g. the MCP run_workflow handler). Skips the duplicate loadAll()+get().
   */
  registration?: RegisteredWorkflow;
}

export interface StartRunResult {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: "running";
  message: string;
}

/**
 * Standalone run lifecycle — the single copy shared by every door into the
 * harness (MCP SDK path today, daemon in Phase C).
 *
 * Uses `host` for resources (`registry`, `tracker`, `bgRuns`) and fans
 * progress out through `host.onProgress`. Owns the run mechanics glue only:
 * launch, background fire, completion/error bookkeeping. The orchestration
 * engine itself stays in `./orchestrator/orchestrator.js`.
 */
export async function startRun(
  host: RunHost,
  task: string,
  workflowId: string,
  resume: boolean,
  opts?: StartRunOptions,
): Promise<StartRunResult> {
  let found = opts?.registration;
  if (!found) {
    host.registry.loadAll();
    found = host.registry.get(workflowId);
  }
  if (!found) throw new Error(`Unknown workflowId: ${workflowId}`);

  const plan: PlannerResult = { workflow: found.definition, source: "registered", registration: found };
  const runId = crypto.randomUUID();
  const workflowName = plan.workflow.workflow.name;

  const stepEntries = plan.workflow.workflow.steps.map((s: any) => ({
    stepId: s.id,
    agent: s.agent || null,
    task: s.task || null,
    signals: [...(s.on || []), ...(s.any || [])],
  }));
  const totalSteps = stepEntries.length;

  host.tracker.createRun(runId, plan.workflow.workflow.id, workflowName, task, host.adapter.id, stepEntries);

  const runTracker: RunTracker = { runId, tracker: host.tracker };
  const rootDir = host.projectDir ?? process.cwd();
  const checkpointer = new Checkpointer(path.join(rootDir, ".orc", "checkpoints.sqlite"));

  const notify = (event: ProgressEvent): void => {
    opts?.onEvent?.(event);
    host.onProgress(event);
  };

  // Fire orchestrate() in the background — do NOT await here.
  // This lets run_workflow return immediately, avoiding the client-side timeout.
  const bgPromise = orchestrate(task, host.adapter, plan, resume, runTracker, checkpointer, notify, rootDir)
    .then((report) => {
      host.bgRuns.delete(runId);
      log.info(`[run ${runId}] Workflow "${workflowId}" completed: ${report.completed}/${report.totalSteps} completed`);
      notifyMainPty(buildCompletionPrompt(runId, workflowName, report));
      return report;
    })
    .catch((err: any) => {
      host.bgRuns.delete(runId);
      log.warn(`[run ${runId}] Workflow "${workflowId}" failed: ${err.message}`);
      try { host.tracker.updateRunStatus(runId, "failed"); } catch { /* ignore */ }
      // Build the failure report from the tracker's actual per-step state so
      // steps that already completed before the failure are not miscounted.
      const snap = host.tracker.getRun(runId);
      const stepStates = snap?.steps ?? [];
      const completed = stepStates.filter(s => s.status === "completed").length;
      const failReport: RunReport = {
        workflowId,
        source: plan.source,
        outcomes: stepStates.map(s => ({
          stepId: s.stepId,
          status: s.status === "completed" ? "completed" : "failed",
          error: s.error ?? undefined,
          retries: 0,
        })),
        totalSteps,
        completed,
        failed: totalSteps - completed,
      };
      notify({ type: "workflow_complete", runId, status: "failed", report: failReport });
      notifyMainPty(buildCompletionPrompt(runId, workflowName, failReport));
      throw err;
    });

  host.bgRuns.set(runId, bgPromise);
  // Keep the stored promise's rejection marked handled even when nothing
  // awaits it (GUI topology, or headless when no get_run_status poll arrives):
  // otherwise a failed run becomes an unhandled rejection and can crash the
  // process. The .catch above still propagates to the blocking status path.
  void bgPromise.catch(() => {});

  return {
    runId,
    workflowId,
    workflowName,
    status: "running",
    message: hasPtyWriter()
      ? "Workflow started in background. You will be notified via the terminal when it completes."
      : "Workflow started in background. Call get_run_status with this runId to check progress.",
  };
}

/**
 * Marks runs left in "running" state by a previous process as failed.
 *
 * Runs are only "running" while a live background orchestrate() exists in
 * `host.bgRuns`; at process startup that map is empty, so any "running" row
 * is an orphan of a crash/restart. Called once when the server starts.
 */
export function reconcileStaleRuns(host: RunHost): void {
  for (const run of host.tracker.listRuns()) {
    if (run.status === "running" && !host.bgRuns.has(run.runId)) {
      log.warn(`[run ${run.runId}] Orphaned running run (no active background job) — marking failed`);
      try { host.tracker.updateRunStatus(run.runId, "failed"); } catch { /* ignore */ }
    }
  }
}