import { type IPty } from "node-pty";
import type { StepOutcome } from "../step-runner.js";
import type { Tracker } from "../Tracker.js";

export interface RunReport {
  workflowId: string;
  source: "registered" | "dynamic" | "llm_classified" | "generated";
  outcomes: StepOutcome[];
  totalSteps: number;
  completed: number;
  failed: number;
}

export interface ProgressEvent {
  type: "step_start" | "step_complete" | "workflow_complete" | "error" | "step_pty";
  runId?: string;
  stepId?: string;
  agent?: string;
  task?: string;
  status?: string;
  duration?: number;
  error?: string;
  pty?: IPty;
  report?: RunReport;
}

export interface RunTracker {
  runId: string;
  tracker: Tracker;
}

export interface StepSummary {
  summary: string;
  artifact: string;
  affectedFiles: string[];
}

export interface OrcReturnResult {
  summary?: string;
  artifact?: string;
  affectedFiles?: string[];
  signal?: boolean;
}
