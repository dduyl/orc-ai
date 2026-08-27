import * as crypto from "node:crypto";
import type { Checkpointer } from "../persistence/Checkpointer.js";
import type { StepOutcome } from "../execution/step-runner.js";
import { log } from "../../../core/log.js";
import type { ProgressEvent, RunTracker } from "./types.js";

export interface ResumeResult {
  sessionId: string;
  restoredStepResults: Map<string, StepOutcome>;
}

export function restoreSession(
  task: string,
  resume: boolean | undefined,
  cp: Checkpointer,
  workflowId: string,
  tracker?: RunTracker,
  onProgress?: (event: ProgressEvent) => void,
): ResumeResult {
  let sessionId: string;
  const restoredStepResults = new Map<string, StepOutcome>();

  if (resume) {
    const existing = cp.load(task);
    if (existing) {
      // Guard: if the checkpoint's workflowId doesn't match the current workflow,
      // treat as no checkpoint (fresh start). Prevents stale step results from
      // being restored when the user switches workflows (e.g., feat-impl -> bug-fix).
      if (existing.workflowId !== workflowId) {
        log.warn(`[resume] Checkpoint workflowId "${existing.workflowId}" does not match current "${workflowId}" — starting fresh`);
        sessionId = crypto.randomUUID();
      } else {
        sessionId = existing.sessionId;
        for (const [stepId, r] of Object.entries(existing.stepResults)) {
          if (r.status !== "failed") {
            restoredStepResults.set(stepId, {
              stepId,
              status: r.status,
              output: r.output,
              error: r.error,
              retries: r.retries,
              hooks: r.hooks,
              signal: r.signal,
              summary: r.summary,
              artifact: r.artifact,
              affectedFiles: r.affectedFiles,
              failureReason: r.failureReason,
              quota: r.quota,
              downgradedTo: r.downgradedTo,
              providerFailover: r.providerFailover,
              needsHuman: r.needsHuman,
            });
          }
        }
        log.info(`[resume] Restored ${restoredStepResults.size}/${Object.keys(existing.stepResults).length} completed steps (session=${sessionId})`);
        if (tracker) {
          const run = tracker.tracker.getRun(tracker.runId);
          if (run) {
            for (const [stepId, r] of restoredStepResults) {
              if (r.status === "completed") {
                tracker.tracker.setStepCompleted(tracker.runId, stepId, "completed", r.error);
                onProgress?.({ type: "step_complete", runId: tracker.runId, stepId, status: "completed", error: r.error });
              }
            }
          }
        }
      }
    } else {
      sessionId = crypto.randomUUID();
      log.info(`[resume] No checkpoint found for "${task}", starting fresh`);
    }
  } else {
    sessionId = crypto.randomUUID();
  }

  return { sessionId, restoredStepResults };
}
