import { app, BrowserWindow, ipcMain } from "electron";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type IPty } from "node-pty";
import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { McpServer } from "../mcp/server.js";
import { WorkflowRegistry } from "../planner/registry.js";
import type { ProgressEvent } from "../harness/orchestrator.js";
import { setStreamEventHandler } from "../stream/emitter.js";
import { registerPtyWriter } from "../harness/pty-notifier.js";

const MCP_PORT = 3100;

const MAIN_STEP_ID = "__main__";

interface PTYEntry {
  pty: IPty;
  name: string;
  buffer: string;
}

function getGuiDir(): string {
  const devDir = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(devDir, "index.html"))) return devDir;
  const exeDir = join(dirname(process.execPath), "gui");
  if (existsSync(join(exeDir, "index.html"))) return exeDir;
  return devDir;
}

const guiDir = getGuiDir();

let win: BrowserWindow | undefined;
const ptyMap = new Map<string, PTYEntry>();
let activeStepId: string | null = null;

function send(channel: string, data: unknown): void {
  if (win?.webContents) {
    win.webContents.send(channel, data);
  }
}

function switchToStep(stepId: string): void {
  activeStepId = stepId;
  send("step-activated", { stepId });
  send("log", { text: `Switched to: ${ptyMap.get(stepId)?.name || stepId}` });
}

function getRunDb(): Database.Database | null {
  const dbPath = resolve(process.cwd(), ".orc", "runs.sqlite");
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function spawnMainPTY(adapterId: string): void {
  try {
    const envPath = join(process.cwd(), ".env");
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = value;
      }
    }

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
    ptyMap.set(MAIN_STEP_ID, entry);

    // Register the writer so background orchestrate() completions can push
    // the [ORC] notification prompt directly into opencode's PTY input.
    registerPtyWriter((text: string) => {
      ptyMap.get(MAIN_STEP_ID)?.pty.write(text);
    });

    send("status", { type: "spawned", pid: ptyProcess.pid, shell, args, adapter: adapterId });
    send("log", { text: `Main PTY spawned: ${shell} ${args.join(" ")} (pid ${ptyProcess.pid})` });

    win?.setTitle(`ORC — ${adapterId}`);

    ptyProcess.onData((data: string) => {
      entry.buffer += data;
      if (activeStepId === MAIN_STEP_ID) {
        win?.webContents.send("output", data);
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[main] Main PTY exited code=${exitCode} signal=${signal}`);
      send("status", { type: "exited", code: exitCode, signal });
      send("log", { text: `Main process exited with code ${exitCode}` });
      win?.webContents.send("exit", exitCode ?? 0);
      setTimeout(() => app.quit(), 2000);
    });

    activeStepId = MAIN_STEP_ID;
  } catch (err) {
    console.error("[main] Main PTY error:", err);
    send("status", { type: "error", message: String(err) });
    send("log", { text: `ERROR: ${err}` });
  }
}

function startEmbeddedMcp(): void {
  try {
    const registry = new WorkflowRegistry();
    const server = new McpServer(
      { id: "opencode", command: "opencode", label: "OpenCode AI Code Orchestrator" },
      registry,
      (event: ProgressEvent) => {
        if (event.type === "step_pty" && event.pty && event.stepId) {
          const pty = event.pty;
          const name = event.agent || event.stepId;
          if (ptyMap.has(event.stepId)) return;

          const entry: PTYEntry = { pty, name, buffer: "" };
          ptyMap.set(event.stepId, entry);

          pty.onData((data: string) => {
            entry.buffer += data;
            if (activeStepId === event.stepId) {
              win?.webContents.send("output", data);
            }
          });

          pty.onExit(({ exitCode, signal }) => {
            console.log(`[main] Subagent PTY ${event.stepId} exited code=${exitCode}`);
            send("log", { text: `Step "${name}" exited (code ${exitCode})` });
          });

          send("log", { text: `Step "${name}" PTY spawned (step ${event.stepId})` });
          switchToStep(event.stepId);
        }
      },
    );

    server.startHttp(MCP_PORT).then(() => {
      console.log(`[main] Embedded MCP server on http://0.0.0.0:${MCP_PORT}`);
      send("log", { text: `MCP server started on port ${MCP_PORT}` });
    });
  } catch (err) {
    console.error("[main] MCP server error:", err);
  }
}

function createWindow(adapterId: string): void {
  const preloadPath = join(guiDir, "preload.js");

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 300,
    backgroundColor: "#0d0d0d",
    title: `ORC — ${adapterId}`,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.loadFile(join(guiDir, "index.html"));

  win.once("ready-to-show", () => {
    console.log("[main] window ready-to-show, starting PTY + MCP");
    win?.show();
    spawnMainPTY(adapterId);
    startEmbeddedMcp();
  });

  win.on("closed", () => {
    for (const [, entry] of ptyMap) {
      try { entry.pty.kill(); } catch { /* ignore */ }
    }
    win = undefined;
  });
}

/* ── IPC handlers ── */

ipcMain.handle("resize", (_event, cols: number, rows: number) => {
  const entry = activeStepId ? ptyMap.get(activeStepId) : undefined;
  if (entry) {
    try { entry.pty.resize(cols, rows); } catch { /* PTY may be dead */ }
  }
});

ipcMain.on("input", (_event, data: string) => {
  const entry = activeStepId ? ptyMap.get(activeStepId) : undefined;
  if (entry) {
    entry.pty.write(data);
  }
});

ipcMain.handle("switch-step", (_event, stepId: string) => {
  if (!ptyMap.has(stepId)) return;
  switchToStep(stepId);
});

ipcMain.handle("list-steps", () => {
  return Array.from(ptyMap.entries()).map(([id, entry]) => ({
    id,
    name: entry.name,
    isActive: id === activeStepId,
    isMain: id === MAIN_STEP_ID,
  }));
});

ipcMain.handle("get-step-output", (_event, stepId: string) => {
  return ptyMap.get(stepId)?.buffer || "";
});

ipcMain.handle("get-run-status", (_event, runId: string) => {
  const db = getRunDb();
  if (!db) return null;
  try {
    const run = db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as any;
    if (!run) return null;
    const steps = db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY rowid").all(runId);
    return {
      runId: run.run_id,
      workflowId: run.workflow_id,
      workflowName: run.workflow_name,
      task: run.task,
      adapterId: run.adapter_id,
      status: run.status,
      currentStepId: run.current_step_id,
      steps,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      completedAt: run.completed_at,
    };
  } finally {
    db.close();
  }
});

ipcMain.handle("list-runs", () => {
  const db = getRunDb();
  if (!db) return [];
  try {
    const runs = db.prepare("SELECT run_id, workflow_id, workflow_name, status, created_at, updated_at, completed_at FROM runs ORDER BY created_at DESC LIMIT 50").all();
    return runs;
  } finally {
    db.close();
  }
});

app.whenReady().then(() => {
  console.log("[main] app ready, argv:", process.argv);
  setStreamEventHandler((event) => {
    send("stream-event", event);
    send("log", { text: `[stream:${event.type}] ${JSON.stringify(event.part ?? {})}` });
  });
  const adapterId = process.argv.find((a) => a.startsWith("--adapter="))?.split("=")[1]
    ?? process.argv[process.argv.indexOf("--adapter") + 1]
    ?? "opencode";
  console.log("[main] adapterId:", adapterId);
  createWindow(adapterId);
});

app.on("window-all-closed", () => {
  for (const [, entry] of ptyMap) {
    try { entry.pty.kill(); } catch { /* ignore */ }
  }
  app.quit();
});

app.on("before-quit", () => {
  for (const [, entry] of ptyMap) {
    try { entry.pty.kill(); } catch { /* ignore */ }
  }
});