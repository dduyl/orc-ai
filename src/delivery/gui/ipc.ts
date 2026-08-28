/**
 * Single source of truth for the renderer ⇄ main IPC contract.
 *
 * Every channel name and payload type lives here so the tsc-emitted preload /
 * main-process code and the esbuild renderer bundle cannot silently drift.
 *
 * Channel maps are keyed by the EXACT wire channel string (e.g. `"chat-frame"`)
 * and the const below is `satisfies`-checked to mirror those maps 1:1, so a new
 * channel added on either side fails the build until the other side catches up.
 * All imports are type-only (erased at runtime): `ipc.js` carries no node or
 * electron dependency, so it bundles cleanly for the browser.
 */
import type { MainFrame } from "../../application/harness/daemon/main-frame-codec.js";
import type { PromptMention } from "../../application/harness/daemon/rpc-protocol.js";
import type { ProgressEvent, RunReport } from "../../application/harness/orchestrator/index.js";
import type { RunRecord } from "../../application/harness/persistence/Tracker.js";
import type { PermissionRequest } from "../../application/agents/acp/permission.js";
import type { AcpChatFrame, PermissionAnswerKind } from "../../application/agents/acp/types.js";
import type { WorkflowDefinition } from "../../core/schemas.js";
import type { RegisteredWorkflow } from "../../application/planner/registry.js";
import type { WorkflowGraphData, SignalEvent } from "../../core/workflow-graph.js";
import type { AgentUsage } from "../../application/agents/acp/types.js";
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
export type {
  PermissionRequest,
  PermissionAnswerKind,
  PromptMention,
  WorkflowDefinition,
  RegisteredWorkflow,
  WorkflowGraphData,
  SignalEvent,
  RunReport,
};

/**
 * A file or directory entry under a directory listing.
 *
 * Local-fs mirror of the removed ACP HTTP file API (Phase 5 v2): the preload
 * walks the workspace with `node:fs`, so the renderer never talks to the
 * agent's HTTP server. Shape stays identical to the old `AcpDirEntry`/`AcpFindResult`
 * so the renderer's `@`-mention picker logic is untouched.
 */
export interface FsEntry {
  name: string;
  /** Relative path within the listed directory. */
  path: string;
  /** Absolute path of the entry. */
  absolute: string;
  type: "file" | "directory";
}

/** Result of a local `@`-mention expansion query. */
export interface FsFindResult {
  /** Entries directly completing the query. */
  entries: FsEntry[];
  /** Directory these entries were listed from (`@dir/` expansion), if any. */
  dir?: string;
}

/** A custom instruction mode from `~/.orc/modes/`. */
export interface CustomMode {
  /** File basename without the extension, e.g. `security-review`. */
  name: string;
  /** Full instruction file content (prepended to every prompt in this mode). */
  content: string;
}

/** Main-terminal status event forwarded to the renderer. */
export type StatusEvent =
  | { type: "spawned"; pid: number | null; adapter: string; mode: "pty" | "acp" }
  | { type: "error"; message: string }
  | { type: "exited"; code: number };

/** One selectable PTY step row in the sidebar (the main terminal is synthetic). */
export interface StepInfo {
  id: string;
  name: string;
  isActive: boolean;
  isMain: boolean;
}

/**
 * Structured chat event for the renderer's DOM chat panel.
 *
 * The main session's ACP frames are forwarded verbatim (kinds: text, tool,
 * tool_update, usage, turn, error); `user` is synthesized locally so the panel
 * shows composed prompts the same way the wire stream does.
 */
export type ChatFrame = MainFrame | { kind: "user"; text: string };

/**
 * Structured step metadata broadcast when a step completes.
 * Carries agent usage, model, duration, tool calls, and structured error info.
 */
export interface StepFrame {
  stepId: string;
  runId: string;
  status: string;
  usage?: AgentUsage;
  model?: string;
  duration?: number;
  toolCalls?: ToolCall[];
  error?: string;
  errorKind?: string;
  resetAtMs?: number;
  retryAfterMs?: number;
  providerCode?: string;
}

/** Per-step chat frame: streaming text or a structured agent event. */
export type StepChatFrame =
  | { textChunk: string; chatFrame?: never }
  | { textChunk?: never; chatFrame: AcpChatFrame };

// ── Payload contracts (keyed by wire channel name) ─────────────────────────

/** Main → renderer event channels: name → payload type. */
export interface MainToRendererEvents {
  output: string;
  exit: number;
  status: StatusEvent;
  log: { text: string };
  "step-activated": { stepId: string };
  "run-active": { runId: string };
  "permission-requested": PermissionRequest;
  "chat-frame": { frame: ChatFrame };
  "chat-reset": Record<string, never>;
  "stream-event": ProgressEvent;
  "workflow-started": { runId: string; workflowId: string; workflow: WorkflowDefinition };
  "workflow-complete": { runId: string; status: "completed" | "failed"; finalSignal?: string; report?: RunReport };
  "signal-emitted": { stepId: string; signal: string; payload?: unknown; timestamp: number };
  "edge-matched": { fromStep: string; signal: string; toStep: string; timestamp: number };
  "gate-result": { stepId: string; gate: string; exitCode: number; output: string };
  "loop-detected": { stepId: string; iteration: number; reason: string; fromSignal: string };
  "step-context": { stepId: string; agent: string; context: string[]; emits: string[] };
  "step-frame": StepFrame;
  "step-chat": { stepId: string; runId: string } & StepChatFrame;
}

/** The main process's channel → payload send function consumed by the bridge. */
export type MainSender = <K extends keyof MainToRendererEvents>(
  channel: K,
  data: MainToRendererEvents[K],
) => void;

/** Renderer → main fire-and-forget channels: name → argument list. */
export interface RendererToMainSend {
  input: [data: string];
  "cancel-main": [];
  "answer-permission": [requestId: string, kind: PermissionAnswerKind];
}

/** Renderer → main invoke channels: name → argument list + result type. */
export interface RendererToMainInvoke {
  prompt: { args: [text: string, mentions?: PromptMention[]]; result: void };
  "switch-step": { args: [stepId: string]; result: void };
  "list-steps": { args: []; result: StepInfo[] };
  "get-step-output": { args: [stepId: string]; result: string };
  start: { args: [task: string, workflowId: string]; result: { runId: string } };
  "get-run-status": { args: [runId: string]; result: RunRecord };
  "list-runs": { args: []; result: RunRecord[] };
  "set-config-option": { args: [configId: string, value: string]; result: void };
  "start-workflow": { args: [task: string, workflowId: string, params?: Record<string, unknown>]; result: { runId: string } };
  "get-workflow-graph": { args: [runId: string]; result: WorkflowGraphData };
  "get-signal-trace": { args: [runId: string, limit?: number]; result: SignalEvent[] };
  "list-workflows": { args: []; result: RegisteredWorkflow[] };
  /** Boot output of the spawned daemon (renderer pulls once it is listening). */
  "get-boot-log": { args: []; result: string[] };
}

// ── Channel names (runtime strings, mirrored 1:1 to the contracts) ─────────

/** Runtime channel-name constants, enforced to match the contracts above. */
export const IPC = {
  RendererToMain: {
    input: "input",
    "cancel-main": "cancel-main",
    "answer-permission": "answer-permission",
  },
  RendererToMainInvoke: {
    prompt: "prompt",
    "switch-step": "switch-step",
    "list-steps": "list-steps",
    "get-step-output": "get-step-output",
    start: "start",
    "get-run-status": "get-run-status",
    "list-runs": "list-runs",
    "set-config-option": "set-config-option",
    "start-workflow": "start-workflow",
    "get-workflow-graph": "get-workflow-graph",
    "get-signal-trace": "get-signal-trace",
    "list-workflows": "list-workflows",
    "get-boot-log": "get-boot-log",
  },
  MainToRenderer: {
    output: "output",
    exit: "exit",
    status: "status",
    log: "log",
    "step-activated": "step-activated",
    "run-active": "run-active",
    "permission-requested": "permission-requested",
    "chat-frame": "chat-frame",
    "chat-reset": "chat-reset",
    "stream-event": "stream-event",
    "workflow-started": "workflow-started",
    "workflow-complete": "workflow-complete",
    "signal-emitted": "signal-emitted",
    "edge-matched": "edge-matched",
    "gate-result": "gate-result",
    "loop-detected": "loop-detected",
    "step-context": "step-context",
    "step-frame": "step-frame",
    "step-chat": "step-chat",
  },
} as const satisfies {
  RendererToMain: Record<keyof RendererToMainSend, string>;
  RendererToMainInvoke: Record<keyof RendererToMainInvoke, string>;
  MainToRenderer: Record<keyof MainToRendererEvents, string>;
};

// ── Preload surface ─────────────────────────────────────────────────────────

/** The API surface `preload.ts` exposes on `window.electronAPI`. */
export interface GuiApi {
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  onStatus(cb: (data: StatusEvent) => void): void;
  onLog(cb: (data: { text: string }) => void): void;
  onStepActivated(cb: (data: { stepId: string }) => void): void;
  onRunActive(cb: (data: { runId: string }) => void): void;
  onPermissionRequested(cb: (data: PermissionRequest) => void): void;
  onChatFrame(cb: (data: { frame: ChatFrame }) => void): void;
  onChatReset(cb: () => void): void;
  onWorkflowStarted(cb: (data: { runId: string; workflowId: string; workflow: WorkflowDefinition }) => void): void;
  onWorkflowComplete(cb: (data: { runId: string; status: "completed" | "failed"; finalSignal?: string; report?: RunReport }) => void): void;
  onSignalEmitted(cb: (data: { stepId: string; signal: string; payload?: unknown; timestamp: number }) => void): void;
  onEdgeMatched(cb: (data: { fromStep: string; signal: string; toStep: string; timestamp: number }) => void): void;
  onGateResult(cb: (data: { stepId: string; gate: string; exitCode: number; output: string }) => void): void;
  onLoopDetected(cb: (data: { stepId: string; iteration: number; reason: string; fromSignal: string }) => void): void;
  onStepContext(cb: (data: { stepId: string; agent: string; context: string[]; emits: string[] }) => void): void;
  onStepFrame(cb: (data: StepFrame) => void): void;
  onStepChat(cb: (data: { stepId: string; runId: string } & StepChatFrame) => void): void;
  write(data: string): void;
  prompt(text: string, mentions?: PromptMention[]): Promise<void>;
  cancelMain(): void;
  answerPermission(requestId: string, kind: PermissionAnswerKind): void;
  switchStep(stepId: string): Promise<void>;
  listSteps(): Promise<StepInfo[]>;
  getStepOutput(stepId: string): Promise<string>;
  start(task: string, workflowId: string): Promise<{ runId: string }>;
  getRunStatus(runId: string): Promise<RunRecord>;
  listRuns(): Promise<RunRecord[]>;
  /** Set an ACP session config option (e.g. the model) on the main session. */
  setConfigOption(configId: string, value: string): Promise<void>;
  /** Expand an `@`-mention token against the local workspace (preload fs walk). */
  findFiles(query: string): Promise<FsFindResult>;
  /** List a directory's children against the local workspace (preload fs walk). */
  listDir(path: string): Promise<FsEntry[]>;
  /** Custom instruction modes from `~/.orc/modes/` (preload fs read). */
  getCustomModes(): Promise<CustomMode[]>;
  /**
   * Names of installed skills (dirs with a `SKILL.md` under the workspace's and
   * home's `.claude`/`.agents`/`.opencode/skills`). Used to group the `/`
   * command picker into `cmd` / `skill` / `other`.
   */
  listSkills(): Promise<string[]>;
  /** Start a workflow run with task and optional parameters. */
  startWorkflow(task: string, workflowId: string, params?: Record<string, unknown>): Promise<{ runId: string }>;
  /** Get the workflow graph data for a run. */
  getWorkflowGraph(runId: string): Promise<WorkflowGraphData>;
  /** Get the signal trace for a run. */
  getSignalTrace(runId: string, limit?: number): Promise<SignalEvent[]>;
  /** List all available workflows (builtins + user). */
  listWorkflows(): Promise<RegisteredWorkflow[]>;
  /** Boot output of the spawned daemon, buffered in main (renderer pulls on load). */
  getBootLog(): Promise<string[]>;
}

declare global {
  interface Window {
    electronAPI: GuiApi;
  }
}