import { type IPty } from "node-pty";
import type { StepOutcome } from "../execution/step-runner.js";
import type { Tracker } from "../persistence/Tracker.js";
import type { QuotaInfo } from "../../agents/errors.js";
import type { AgentUsage } from "../../agents/acp/types.js";
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";

export interface RunReport {
  workflowId: string;
  source: "registered" | "dynamic" | "llm_classified" | "generated";
  outcomes: StepOutcome[];
  totalSteps: number;
  completed: number;
  failed: number;
  /** ADR-022: number of steps that paused the run (quota), 0 or 1. */
  paused: number;
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
  quota?: QuotaInfo;
  pty?: IPty;
  report?: RunReport;
  /** Agent token usage from the step (ACP). */
  usage?: AgentUsage;
  /** Agent model identifier from the step. */
  model?: string;
  /** Structured tool calls from the step (ACP). */
  toolCalls?: ToolCall[];
  /** ADR-022: classified error kind from step failure. */
  errorKind?: string;
  /** ADR-022: provider-announced quota window reset, ms epoch. */
  resetAtMs?: number;
  /** ADR-022: provider-announced retry delay for rate limits, in ms. */
  retryAfterMs?: number;
  /** ADR-022: provider error code when one is surfaced. */
  providerCode?: string;
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
  /** Signal NAME, must be one of the step's `emits` (ADR-011). */
  signal?: string;
}
