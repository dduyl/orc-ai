import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PipeClient, type TerminalStream } from "../../application/harness/daemon/pipe-client.js";
import { MAIN_STEP_ID, SCREEN_STEP_ID } from "../../application/harness/daemon/frame-transport.js";
import type { WorkflowCompleteInfo } from "../../application/harness/daemon/daemon-server.js";
import { decodeMainFrame, type MainFrame } from "../../application/harness/daemon/main-frame-codec.js";
import type { ProgressEvent } from "../../application/harness/orchestrator/index.js";
import type { RunRecord } from "../../application/harness/persistence/Tracker.js";
import type { PermissionRequest } from "../../application/agents/acp/permission.js";
import type { PermissionAnswerKind } from "../../application/agents/acp/types.js";
import { getAdapter } from "../../application/agents/adapter.js";

/**
 * GUI → daemon bridge (Phase D D-4).
 *
 * The Electron GUI is a pure `PipeClient`: it spawns-or-attaches the daemon
 * block, streams terminal frames, and never owns a PTY, MCP server, or SQLite
 * handle itself. This class keeps the renderer's IPC contract intact (it is
 * the replacement for `PtyManager` + `run-db.ts`):
 *
 * - main terminal + per-run step terminals are demuxed by the frame `stepId`
 *   header into per-step buffers (no `[step: …]` text-marker parsing);
 * - `input` routes to the focused step via the daemon's `input` RPC (steps
 *   need the current `runId`, the main terminal does not);
 * - run status/tree comes from `PipeClient.status()/list()`, never SQLite.
 */
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

export class DaemonBridge {
  private client: PipeClient | null = null;
  private daemonChild: ChildProcess | null = null;
  private daemonPid: number | null = null;

  private mainStream: TerminalStream | null = null;
  private runStream: TerminalStream | null = null;
  private attachedRuns = new Set<string>();

  private mainBuffer = "";
  private stepBuffers = new Map<string, string>();
  /** `pty` → raw ANSI bytes on the main pipe; `acp` → structured `MainFrame`s. */
  private mainMode: "pty" | "acp" = "pty";
  private activeStepId = MAIN_STEP_ID;
  private latestRunId: string | null = null;
  private mainExited = false;
  private adapterId = "opencode";

  constructor(private readonly send: (channel: string, data: unknown) => void) {}

  /** Spawn-or-attach the daemon block, then bind the main terminal. */
  async connect(projectDir: string, adapterId: string): Promise<void> {
    this.adapterId = adapterId;
    const client = await this.ensureDaemon(projectDir);
    this.client = client;
    this.latestRunId = null;
    await this.attachMain();
  }

  async startRun(task: string, workflowId: string): Promise<{ runId: string }> {
    const client = this.requireClient();
    const res = await client.start({ task, workflowId });
    this.trackRun(res.runId);
    this.stepBuffers.clear();
    this.send("log", { text: `Run started: ${workflowId}` });
    await this.attachRunTerminal(res.runId);
    return res;
  }

  async getRunStatus(runId: string): Promise<RunRecord> {
    return this.requireClient().status(runId);
  }

  async listRuns(): Promise<RunRecord[]> {
    return this.requireClient().list();
  }

  listSteps(): StepInfo[] {
    const steps: StepInfo[] = [
      { id: MAIN_STEP_ID, name: "orchestrator", isActive: this.activeStepId === MAIN_STEP_ID, isMain: true },
    ];
    for (const id of this.stepBuffers.keys()) {
      steps.push({ id, name: id, isActive: id === this.activeStepId, isMain: false });
    }
    return steps;
  }

  getStepOutput(stepId: string): string {
    if (stepId === MAIN_STEP_ID) return this.mainBuffer;
    return this.stepBuffers.get(stepId) ?? "";
  }

  switchToStep(stepId: string): void {
    this.activeStepId = stepId;
    this.send("step-activated", { stepId });
    this.send("log", { text: `Switched to: ${this.stepName(stepId)}` });
  }

  /** Route keyboard input to the focused PTY (main or the active run's step). */
  async writeInput(data: string): Promise<void> {
    const client = this.requireClient();
    if (this.activeStepId === MAIN_STEP_ID) {
      // In ACP mode the main terminal is a chat session, not a PTY: a keystroke
      // is not bytes-for-a-tty, it is a whole prompt line.
      if (this.mainMode === "acp") {
        await client.prompt(data);
        return;
      }
      await client.writeInput({ stepId: MAIN_STEP_ID, data });
      return;
    }
    if (!this.latestRunId) throw new Error("no active run for step input");
    await client.writeInput({ runId: this.latestRunId, stepId: this.activeStepId, data });
  }

  /** Submit a whole prompt turn to the ACP main session (chat mode). */
  async prompt(text: string): Promise<void> {
    if (this.mainMode !== "acp") throw new Error("main terminal is not an ACP session");
    await this.requireClient().prompt(text);
  }

  /** Cancel the ACP main session's in-flight turn. */
  async cancelMain(): Promise<void> {
    await this.requireClient().cancelMain();
  }

  /** Answer the ACP main session's permission request by correlation id. */
  async answerPermission(requestId: string, kind: PermissionAnswerKind): Promise<void> {
    await this.requireClient().answerPermission(requestId, kind);
  }

  dispose(): void {    this.mainStream?.close();
    this.runStream?.close();
    this.client?.dispose();
    this.client = null;
    // Never stop the daemon — it outlives the GUI (D-2).
  }

  // --- daemon lifecycle ----------------------------------------------------

  private requireClient(): PipeClient {
    if (!this.client) throw new Error("not connected to daemon");
    return this.client;
  }

  private async ensureDaemon(projectDir: string): Promise<PipeClient> {
    // Attach first: a daemon may already own this project.
    const existing = await this.tryConnect(projectDir, 1500);
    if (existing) return existing;

    // No daemon — spawn the block, then wait for its control pipe.
    const child = this.spawnDaemon(projectDir);
    this.daemonChild = child;
    this.daemonPid = child.pid ?? null;
    child.stdout?.on("data", (d) => this.send("log", { text: String(d).trimEnd() }));
    child.stderr?.on("data", (d) => this.send("log", { text: String(d).trimEnd() }));
    child.once("exit", () => {
      this.daemonPid = null;
      this.send("log", { text: "daemon exited" });
    });

    const client = await this.tryConnect(projectDir, 10_000);
    if (client) return client;
    try { child.kill(); } catch { /* ignore */ }
    throw new Error("daemon did not come up within 10s");
  }

  private tryConnect(projectDir: string, timeoutMs: number): Promise<PipeClient | null> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const attempt = (): void => {
        if (Date.now() > deadline) return resolve(null);
        PipeClient.connect({
          projectDir,
          onProgress: (e) => this.onProgress(e),
          onWorkflowComplete: (i) => this.onWorkflowComplete(i),
          onPermissionRequested: (request) => this.onPermissionRequested(request),
        })
          .then(resolve)
          .catch(() => setTimeout(attempt, 100));
      };
      attempt();
    });
  }

  private spawnDaemon(projectDir: string): ChildProcess {
    const env = { ...(process.env as Record<string, string>) };
    // `node-pty` is host-only (D-5), so the daemon must run under host Node —
    // never under Electron's embedded runtime (`ELECTRON_RUN_AS_NODE` would use
    // the Electron ABI and fail to load the host-rebuilt addon).
    let command: string;
    let args: string[];
    const mainArgs = this.isAcpMode(env) ? ["--main", "acp"] : [];
    if (env["ORC_DAEMON_BIN"]) {
      command = env["ORC_DAEMON_BIN"];
      args = ["daemon", "start", ...mainArgs];
    } else if (this.isPackagedApp) {
      command = this.resolveBundledOrc();
      args = ["daemon", "start", ...mainArgs];
    } else {
      // Dev: root the CLI from the compiled output and run it with the host
      // `node` on PATH (the same runtime the rebuild targets).
      command = "node";
      args = [join(dirname(fileURLToPath(import.meta.url)), "../cli/index.js"), "daemon", "start", ...mainArgs];
    }
    return spawn(command, args, { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] });
  }

  /** `ORC_MAIN_MODE=acp` (or a binary expecting ACP) drives the main session over ACP. */
  private isAcpMode(env: Record<string, string>): boolean {
    return env["ORC_MAIN_MODE"] === "acp";
  }

  private get isPackagedApp(): boolean {
    return !!process.resourcesPath && existsSync(join(process.resourcesPath, "app.asar"));
  }

  private resolveBundledOrc(): string {
    const ext = process.platform === "win32" ? "orc.exe" : "orc";
    const candidates = process.resourcesPath
      ? [join(process.resourcesPath, ext), join(dirname(process.execPath), ext)]
      : [];
    const found = candidates.find((p) => existsSync(p));
    if (found) return found;
    throw new Error("bundled `orc` binary not found (set ORC_DAEMON_BIN to its path)");
  }

  private async attachMain(): Promise<void> {
    const client = this.requireClient();
    const res = await client.attachMain();
    this.mainMode = res.mode;
    this.mainExited = false;
    // A fresh attach is a fresh conversation: the daemon replays the buffered
    // frames (V3), so drop the old ANSI buffer and tell the renderer to clear
    // its chat DOM before the replay lands, otherwise stale bubbles persist
    // across connects / new main sessions (V4).
    this.mainBuffer = "";
    this.send("chat-reset", {});
    this.mainStream = await client.attachMainStream(
      (stepId, payload) => {
        if (stepId !== MAIN_STEP_ID) return;
        if (this.mainMode === "acp") {
          this.onMainFrame(payload);
        } else {
          const text = payload.toString("utf8");
          this.mainBuffer += text;
          if (this.activeStepId === MAIN_STEP_ID) this.send("output", text);
        }
      },
      () => {
        if (this.mainExited) return;
        this.mainExited = true;
        this.send("exit", 0);
      },
    );
    this.send("status", {
      type: "spawned",
      pid: this.daemonPid,
      adapter: this.adapterId,
      mode: this.mainMode,
    });
    this.send("log", { text: "attached to daemon main terminal" });
    this.switchToStep(MAIN_STEP_ID);
  }

  /**
   * ACP main frames are structured JSON envelopes, not tty bytes. They drive
   * two surfaces:
   *
   * - a structured `chat-frame` event → the renderer's DOM chat panel (D-7);
   * - a human-readable ANSI line (same rendering the daemon CLI uses) so the
   *   xterm Terminal view stays coherent on re-attach / step switching.
   */
  private onMainFrame(payload: Buffer): void {
    let frame: MainFrame;
    try {
      frame = decodeMainFrame(payload);
    } catch {
      return; // not a MainFrame (stale PTY bytes) — drop
    }
    this.send("chat-frame", { frame });
    const text = renderMainFrame(frame);
    if (!text) return;
    this.mainBuffer += text;
    if (this.activeStepId === MAIN_STEP_ID) this.send("output", text);
  }

  private onPermissionRequested(request: PermissionRequest): void {
    this.send("permission-requested", request);
    const label = request.toolCall.title ?? request.toolCall.name ?? "tool";
    this.send("log", {
      text: `[permission] ${label} — waiting for your decision`,
    });
  }

  private async attachRunTerminal(runId: string): Promise<void> {
    if (this.attachedRuns.has(runId)) return;
    this.attachedRuns.add(runId);
    const client = this.requireClient();
    try {
      await client.attach(runId);
    } catch (err: any) {
      // Run may have just finished; nothing to stream.
      this.send("log", { text: `attach run ${runId}: ${err?.message ?? err}` });
      this.attachedRuns.delete(runId);
      return;
    }
    this.runStream?.close();
    try {
      this.runStream = await client.attachTerminal(
        runId,
        (stepId, payload) => this.onRunFrame(stepId, payload),
        () => {
          this.runStream = null;
        },
      );
    } catch (err: any) {
      // Terminal connect failed (e.g. the run finished and evicted its pipe
      // between attach() and the terminal socket). Not fatal — the progress
      // stream still carries status/tree. Release the run so a retry is possible.
      this.attachedRuns.delete(runId);
      this.send("log", { text: `attach run terminal ${runId}: ${err?.message ?? err}` });
    }
  }

  private onRunFrame(stepId: string, payload: Buffer): void {
    const text = payload.toString("utf8");
    // The `__screen__` replay frame carries a finished run's combined scrollback
    // (reconstructed from its disk log on re-attach, ADR-025 Phase E #16). Surface
    // it as the run's combined view rather than dropping it: a run that already
    // completed before attach has no per-step live frames, so the whole-history
    // replay is the only content the client sees.
    if (stepId === SCREEN_STEP_ID) {
      this.stepBuffers.set(SCREEN_STEP_ID, (this.stepBuffers.get(SCREEN_STEP_ID) ?? "") + text);
      this.send("output", text);
      return;
    }
    this.stepBuffers.set(stepId, (this.stepBuffers.get(stepId) ?? "") + text);
    if (this.activeStepId === stepId) this.send("output", text);
  }

  private onProgress(event: ProgressEvent): void {
    if (event.runId) {
      this.trackRun(event.runId);
      // Runs started outside the GUI (e.g. via MCP on :3100) still get live
      // terminal frames — attach the run the moment progress announces it.
      if (!this.attachedRuns.has(event.runId)) void this.attachRunTerminal(event.runId);
    }
    if (event.type === "step_start" && event.stepId) {
      if (!this.stepBuffers.has(event.stepId)) this.stepBuffers.set(event.stepId, "");
      if (event.runId === this.latestRunId) this.switchToStep(event.stepId);
    }
    this.send("stream-event", event);
  }

  private onWorkflowComplete(info: WorkflowCompleteInfo): void {
    if (info.runId) {
      this.send("log", { text: `[run ${info.runId}] workflow complete (${info.status ?? "?"})` });
      // Do NOT clear stepBuffers here: the combined `__screen__` replay and per-step
      // buffers keep the finished run viewable after completion (Phase E). Clearing
      // would wipe the history a toasted run is about to show.
      if (this.latestRunId === info.runId) this.switchToStep(MAIN_STEP_ID);
    }
  }

  private stepName(stepId: string): string {
    return stepId === MAIN_STEP_ID ? "orchestrator" : stepId;
  }

  /**
   * Adopt a run as the active one and tell the renderer, which drives the step
   * tree + status polling off a structured `run-active` event rather than
   * parsing log text for `[run <uuid>]` (daemon stdout piped into the log
   * channel could otherwise hijack it).
   */
  private trackRun(runId: string): void {
    if (runId === this.latestRunId) return;
    this.latestRunId = runId;
    this.send("run-active", { runId });
  }
}

/** Adapter name used for the window title / status label. */
export function resolveGuiAdapter(rawAdapterId: string | undefined): string {
  const adapter = getAdapter(rawAdapterId ?? "opencode");
  return adapter?.id ?? rawAdapterId ?? "opencode";
}

/**
 * Translate one ACP main frame into a human-readable ANSI line for the xterm
 * view. Text chunks stream as-is (so the reply reads naturally); every other
 * kind becomes a single labeled line so the chat stays scannable.
 */
export function renderMainFrame(frame: MainFrame): string {
  switch (frame.kind) {
    case "text":
      return frame.text;
    case "tool":
      return `\r\n\x1b[1;36m[tool] ${frame.call.title ?? frame.call.name ?? "tool"}\x1b[0m\r\n`;
    case "tool_update":
      return `\r\n\x1b[2m[tool update] ${frame.update.title ?? frame.update.name ?? "tool"}\x1b[0m\r\n`;
    case "usage":
      return `\r\n\x1b[2m[tokens ${frame.usage.totalTokens} (in ${frame.usage.inputTokens} / out ${frame.usage.outputTokens})]\x1b[0m\r\n`;
    case "turn":
      return `\r\n\x1b[1;32m[turn end: ${frame.stopReason}]\x1b[0m\r\n`;
    case "error":
      return `\r\n\x1b[1;31m[error] ${frame.message}\x1b[0m\r\n`;
    default:
      return "";
  }
}
