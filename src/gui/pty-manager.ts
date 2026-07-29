import { spawn, type IPty } from "node-pty";
import type { BrowserWindow } from "electron";
import { registerPtyWriter } from "../harness/pty-notifier.js";
import { loadDotEnv } from "../cli/env-loader.js";

export const MAIN_STEP_ID = "__main__";

export interface PTYEntry {
  pty: IPty;
  name: string;
  buffer: string;
}

export interface StepInfo {
  id: string;
  name: string;
  isActive: boolean;
  isMain: boolean;
}

export class PtyManager {
  private ptyMap = new Map<string, PTYEntry>();
  activeStepId: string | null = null;

  constructor(
    private send: (channel: string, data: unknown) => void,
    private getWin: () => BrowserWindow | undefined,
    private onQuit: () => void,
  ) {}

  switchToStep(stepId: string): void {
    this.activeStepId = stepId;
    this.send("step-activated", { stepId });
    this.send("log", { text: `Switched to: ${this.ptyMap.get(stepId)?.name || stepId}` });
  }

  spawnMainPTY(adapterId: string): void {
    try {
      loadDotEnv();

      const cmd = adapterId === "opencode"
        ? "opencode"
        : `npx ${adapterId}`;
      const shell = process.platform === "win32"
        ? (process.env.COMSPEC || "cmd.exe")
        : cmd;
      const args: string[] = process.platform === "win32"
        ? ["/c", cmd]
        : [];

      console.log(`[main] spawning main PTY: shell="${shell}" args=${JSON.stringify(args)}`);

      const ptyProcess = spawn(shell, args, {
        cols: 80,
        rows: 24,
        name: "xterm-256color",
        cwd: process.cwd(),
        env: { ...process.env },
      });

      const entry: PTYEntry = { pty: ptyProcess, name: adapterId, buffer: "" };
      this.ptyMap.set(MAIN_STEP_ID, entry);

      // Register the writer so background orchestrate() completions can push
      // the [ORC] notification prompt directly into opencode's PTY input.
      registerPtyWriter((text: string) => {
        this.ptyMap.get(MAIN_STEP_ID)?.pty.write(text);
      });

      this.send("status", { type: "spawned", pid: ptyProcess.pid, shell, args, adapter: adapterId });
      this.send("log", { text: `Main PTY spawned: ${shell} ${args.join(" ")} (pid ${ptyProcess.pid})` });

      this.getWin()?.setTitle(`ORC — ${adapterId}`);

      ptyProcess.onData((data: string) => {
        entry.buffer += data;
        if (this.activeStepId === MAIN_STEP_ID) {
          this.getWin()?.webContents.send("output", data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[main] Main PTY exited code=${exitCode} signal=${signal}`);
        this.send("status", { type: "exited", code: exitCode, signal });
        this.send("log", { text: `Main process exited with code ${exitCode}` });
        this.getWin()?.webContents.send("exit", exitCode ?? 0);
        setTimeout(() => this.onQuit(), 2000);
      });

      this.activeStepId = MAIN_STEP_ID;
    } catch (err) {
      console.error("[main] Main PTY error:", err);
      this.send("status", { type: "error", message: String(err) });
      this.send("log", { text: `ERROR: ${err}` });
    }
  }

  addSubagentPTY(stepId: string, pty: IPty, name: string): void {
    if (this.ptyMap.has(stepId)) return;

    const entry: PTYEntry = { pty, name, buffer: "" };
    this.ptyMap.set(stepId, entry);

    pty.onData((data: string) => {
      entry.buffer += data;
      if (this.activeStepId === stepId) {
        this.getWin()?.webContents.send("output", data);
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      console.log(`[main] Subagent PTY ${stepId} exited code=${exitCode}`);
      this.send("log", { text: `Step "${name}" exited (code ${exitCode})` });
    });

    this.send("log", { text: `Step "${name}" PTY spawned (step ${stepId})` });
    this.switchToStep(stepId);
  }

  writeActive(data: string): void {
    const entry = this.activeStepId ? this.ptyMap.get(this.activeStepId) : undefined;
    if (entry) entry.pty.write(data);
  }

  resizeActive(cols: number, rows: number): void {
    const entry = this.activeStepId ? this.ptyMap.get(this.activeStepId) : undefined;
    if (entry) {
      try { entry.pty.resize(cols, rows); } catch { /* PTY may be dead */ }
    }
  }

  listSteps(): StepInfo[] {
    return Array.from(this.ptyMap.entries()).map(([id, entry]) => ({
      id,
      name: entry.name,
      isActive: id === this.activeStepId,
      isMain: id === MAIN_STEP_ID,
    }));
  }

  getBuffer(stepId: string): string {
    return this.ptyMap.get(stepId)?.buffer || "";
  }

  killAll(): void {
    for (const [, entry] of this.ptyMap) {
      try { entry.pty.kill(); } catch { /* ignore */ }
    }
  }
}
