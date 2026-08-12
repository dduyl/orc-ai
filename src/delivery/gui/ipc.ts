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
import type { ProgressEvent } from "../../application/harness/orchestrator/index.js";
import type { RunRecord } from "../../application/harness/persistence/Tracker.js";
import type { PermissionRequest } from "../../application/agents/acp/permission.js";
import type { PermissionAnswerKind } from "../../application/agents/acp/types.js";
export type { PermissionRequest, PermissionAnswerKind };

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
  prompt: { args: [text: string]; result: void };
  "switch-step": { args: [stepId: string]; result: void };
  "list-steps": { args: []; result: StepInfo[] };
  "get-step-output": { args: [stepId: string]; result: string };
  start: { args: [task: string, workflowId: string]; result: { runId: string } };
  "get-run-status": { args: [runId: string]; result: RunRecord };
  "list-runs": { args: []; result: RunRecord[] };
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
  write(data: string): void;
  prompt(text: string): Promise<void>;
  cancelMain(): void;
  answerPermission(requestId: string, kind: PermissionAnswerKind): void;
  switchStep(stepId: string): Promise<void>;
  listSteps(): Promise<StepInfo[]>;
  getStepOutput(stepId: string): Promise<string>;
  start(task: string, workflowId: string): Promise<{ runId: string }>;
  getRunStatus(runId: string): Promise<RunRecord>;
  listRuns(): Promise<RunRecord[]>;
}

declare global {
  interface Window {
    electronAPI: GuiApi;
  }
}