import * as crypto from "node:crypto";
import * as path from "node:path";
import type { RunHost } from "./run-host.js";
import type { PlannerResult, RegisteredWorkflow } from "../planner/registry.js";
import { orchestrate, type ProgressEvent, type RunReport, type RunTracker } from "./orchestrator/index.js";
import { Checkpointer } from "./persistence/Checkpointer.js";
import type { RunRecord } from "./persistence/Tracker.js";
import { hasPtyWriter, notifyMainPty } from "./signalling/pty-notifier.js";
import { buildCompletionPrompt } from "./completion.js";
import { log } from "../../core/log.js";

export interface StartRunOptions {
  /**
   * Explicit runId for the new run. Lets callers (e.g. the daemon) register
   * the run's abort controller / active marker BEFORE the run can complete —
   * otherwise a fast-finishing workflow can slip past a post-await
   * registration and leak a permanently-active runId. Defaults to a fresh
   * randomUUID when omitted.
   */
  runId?: string;
  /** Transport-specific observer (e.g. SDK progress notifications). Optional. */
  onEvent?: (event: ProgressEvent) => void;
  /**
   * Pre-resolved registration from a caller that already loaded the registry
   * (e.g. the MCP run_workflow handler). Skips the duplicate loadAll()+get().
   */
  registration?: RegisteredWorkflow;
  /**
   * Cooperative cancellation for this run. When aborted, in-flight agent PTYs
   * are killed and the run resolves with a "cancelled" tracker status. The
   * caller keeps the controller and aborts it later (e.g. a `run/cancel` RPC).
   */
  signal?: AbortSignal;
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
  // ADR-022 fix: a manual resume that supplies no runId must resume the most
  // recent paused run for this task/workflow rather than minting a fresh row —
  // otherwise the paused run's wake timer would later resurrect a superseded
  // run. Callers that already resolved the runId (the quota wake itself) pass
  // it explicitly and skip this lookup.
  const runId = opts?.runId ?? (resume ? resolvePausedRunId(host, task, workflowId) : undefined) ?? crypto.randomUUID();
  const workflowName = plan.workflow.workflow.name;

  const stepEntries = plan.workflow.workflow.steps.map((s: any) => ({
    stepId: s.id,
    agent: s.agent || null,
    task: s.task || null,
    signals: [...(s.on || []), ...(s.any || [])],
  }));
  const totalSteps = stepEntries.length;

  // ADR-022: the quota wake timer resumes the SAME runId it paused.
  // Reuse the existing row (paused -> running; updateRunStatus clears the pause
  // metadata) so run history and steps_json survive instead of a PK conflict.
  const existing = resume ? host.tracker.getRun(runId) : null;
  if (existing) {
    // Disarm any pending wake timer for this runId: the run is being resumed
    // NOW (either by the wake firing, or by a manual resume that just claimed
    // this paused run). Without this, a manual resume of a paused run would
    // leave its scheduled auto-resume armed, firing a duplicate orchestrate()
    // on the same runId after the quota window elapsed.
    host.clearPausedRunResume(runId);
    host.tracker.updateRunStatus(runId, "running");
  } else {
    host.tracker.createRun(runId, plan.workflow.workflow.id, workflowName, task, host.adapter.id, stepEntries);
  }

  const runTracker: RunTracker = { runId, tracker: host.tracker };
  const rootDir = host.projectDir ?? process.cwd();
  const checkpointer = new Checkpointer(path.join(rootDir, ".orc", "checkpoints.sqlite"));

  const notify = (event: ProgressEvent): void => {
    opts?.onEvent?.(event);
    host.onProgress(event);
  };

  // Fire orchestrate() in the background — do NOT await here.
  // This lets run_workflow return immediately, avoiding the client-side timeout.
  const bgPromise = orchestrate(task, {
    adapter: host.adapter,
    plan,
    resume,
    tracker: runTracker,
    checkpointer,
    onProgress: notify,
    projectRoot: rootDir,
    signal: opts?.signal,
  })
    .then((report) => {
      host.bgRuns.delete(runId);
      if (report.paused > 0) {
        // ADR-022: a paused run is NOT done — schedule the wake resume
        // and skip the completion prompt (the eventual resume completion fires
        // it). The daemon keeps the run active so attach mid-pause works.
        const pausedOutcome = report.outcomes.find(o => o.status === "paused");
        log.warn(`[run ${runId}] Workflow "${workflowId}" paused (quota) — scheduling auto-resume`);
        host.schedulePausedRunResume(runId, task, workflowId, pausedOutcome?.quota?.resetAtMs);
        return report;
      }
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
      // getRun can throw when the tracker was already closed during shutdown;
      // default to an empty snapshot so the completion notification below still
      // fires instead of being swallowed by this catch handler throwing.
      let snap: RunRecord | null = null;
      try { snap = host.tracker.getRun(runId); } catch { /* ignore */ }
      const stepStates = snap?.steps ?? [];
      const completed = stepStates.filter(s => s.status === "completed").length;
      const failReport: RunReport = {
        workflowId,
        source: plan.source,
        outcomes: stepStates.map(s => ({
          stepId: s.stepId,
          status: s.status === "completed" ? "completed" : "failed",
          error: s.error ?? undefined,
          quota: s.quota ?? undefined,
          retries: 0,
        })),
        totalSteps,
        completed,
        failed: totalSteps - completed,
        paused: 0,
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

/**
 * Resolves the most recent `paused` run for a task/workflow, or undefined.
 *
 * A manual resume must continue the run that was actually paused by quota
 * exhaustion — not start a brand-new run that would leave the paused one's
 * wake timer armed to resurrect a superseded workflow. `listRuns()` returns
 * newest-first, so the first match is the latest pause window.
 */
export function resolvePausedRunId(host: RunHost, task: string, workflowId: string): string | undefined {
  for (const run of host.tracker.listRuns()) {
    if (run.status === "paused" && run.task === task && run.workflowId === workflowId) {
      return run.runId;
    }
  }
  return undefined;
}