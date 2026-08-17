import type { StartRunResult } from "../start-run.js";
import type { RunReport } from "../orchestrator/index.js";
import type { PermissionAnswerKind } from "../../agents/acp/types.js";

/**
 * Control-plane JSON-RPC wire protocol (ADR-025 Phase C step 3).
 *
 * Imported by the daemon (server side, `daemon-server.ts`) and by pipe clients
 * (`pipe-client.ts`, the GUI's `daemon-bridge.ts`) so both sides always agree
 * on method names, notification names, and payload shapes. The GUI must never
 * import `daemon-server.js` itself, so this module is deliberately free of any
 * runtime dependency on the daemon graph.
 */

/** Control-plane JSON-RPC request method names. */
export const RpcMethod = {
  start: "start",
  list: "list",
  status: "status",
  cancel: "cancel",
  attach: "attach",
  stop: "stop",
  attachMain: "attachMain",
  input: "input",
  prompt: "prompt",
  cancelMain: "cancelMain",
  answerPermission: "answerPermission",
  setConfigOption: "setConfigOption",
} as const;

/** Control-plane JSON-RPC notifications (server → client). */
export const RpcNotification = {
  progress: "progress",
  workflowComplete: "workflowComplete",
  permissionRequested: "permissionRequested",
} as const;

export interface StartParams {
  task: string;
  workflowId: string;
  resume?: boolean;
}

/** Result of the `start` request. */
export type StartResult = StartRunResult;

export interface AttachParams {
  runId: string;
}

export interface AttachResult {
  runId: string;
  /** Path of the run's terminal pipe; connect + read length-prefixed frames. */
  terminalPipe: string;
}

/** Result of the `attachMain` request: the daemon-owned main terminal pipe. */
export interface AttachMainResult {
  terminalPipe: string;
  /** `pty` → raw ANSI bytes; `acp` → length-prefixed `MainFrame` JSON frames. */
  mode: "pty" | "acp";
}

/** Payload for the `input` RPC: write `data` to a PTY by step id. */
export interface InputParams {
  /** Omit for the main terminal (`stepId` must be `__main__`). */
  runId?: string;
  /** `__main__` → main PTY; otherwise a step id within `runId`. */
  stepId: string;
  data: string;
}

export interface InputResult {
  ok: true;
}

export interface CancelParams {
  runId: string;
}

export interface CancelResult {
  cancelled: boolean;
  reason?: string;
}

export interface StopResult {
  ok: true;
}

/** Payload for the `prompt` RPC: queue a user prompt on the ACP main session. */
export interface PromptParams {
  text: string;
  /** `@path` mentions to attach as `resource_link` content blocks. */
  mentions?: PromptMention[];
}

/** A `@path` mention extracted from the composer on submit (line ranges optional). */
export interface PromptMention {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface PromptResult {
  queued: true;
}

export interface CancelMainResult {
  ok: true;
}

/** Payload for the `answerPermission` RPC. */
export interface AnswerPermissionParams {
  /** Correlation id from the `permissionRequested` notification being answered. */
  requestId: string;
  kind: PermissionAnswerKind;
}

export interface AnswerPermissionResult {
  answered: boolean;
}

/** Payload for the `setConfigOption` RPC: set an ACP session config option (e.g. model). */
export interface SetConfigOptionParams {
  configId: string;
  value: string;
}

export interface SetConfigOptionResult {
  ok: true;
}

export interface WorkflowCompleteInfo {
  runId?: string;
  status?: string;
  report?: RunReport;
}
