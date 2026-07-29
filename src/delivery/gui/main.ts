import { app, BrowserWindow, dialog } from "electron";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { McpServer } from "../../adapters/mcp/server.js";
import { WorkflowRegistry } from "../../application/planner/registry.js";
import type { ProgressEvent } from "../../application/harness/orchestrator/index.js";
import { setStreamEventHandler } from "../../adapters/stream/emitter.js";
import { getAdapter, BUILTIN_ADAPTERS, type AdapterDef } from "../../application/agents/adapter.js";
import { PtyManager, MAIN_STEP_ID } from "./pty-manager.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { setProjectDir } from "./run-db.js";

const MCP_PORT = 3100;

function getGuiDir(): string {
  const devDir = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(devDir, "index.html"))) return devDir;
  const exeDir = join(dirname(process.execPath), "gui");
  if (existsSync(join(exeDir, "index.html"))) return exeDir;
  return devDir;
}

const guiDir = getGuiDir();

let win: BrowserWindow | undefined;
let ptyManager: PtyManager;

function send(channel: string, data: unknown): void {
  if (win?.webContents) {
    win.webContents.send(channel, data);
  }
}

function startEmbeddedMcp(adapter: AdapterDef, projectDir?: string): void {
  try {
    const registry = new WorkflowRegistry();
    const server = new McpServer(
      adapter,
      registry,
      (event: ProgressEvent) => {
        if (event.type === "step_pty" && event.pty && event.stepId) {
          ptyManager.addSubagentPTY(event.stepId, event.pty, event.agent || event.stepId);
        }
        if (event.type === "workflow_complete") {
          ptyManager.removeSubagentPTYs();
          ptyManager.switchToStep(MAIN_STEP_ID);
        }
      },
      projectDir,
    );

    server.startHttp(MCP_PORT).then(() => {
      console.log(`[main] Embedded MCP server on http://0.0.0.0:${MCP_PORT}`);
      send("log", { text: `MCP server started on port ${MCP_PORT}` });
    });
  } catch (err) {
    console.error("[main] MCP server error:", err);
  }
}

function createWindow(adapter: AdapterDef, projectDir?: string): void {
  const preloadPath = join(guiDir, "preload.js");

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 300,
    backgroundColor: "#0d0d0d",
    title: `ORC — ${adapter.id}`,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
    },
  });

  ptyManager = new PtyManager(send, () => win, () => app.quit(), projectDir);
  registerIpcHandlers(ptyManager);

  win.loadFile(join(guiDir, "index.html"));

  win.once("ready-to-show", () => {
    console.log("[main] window ready-to-show, starting PTY + MCP");
    win?.show();
    ptyManager.spawnMainPTY(adapter.id);
    startEmbeddedMcp(adapter, projectDir);
  });

  win.on("closed", () => {
    ptyManager.killAll();
    win = undefined;
  });
}

app.whenReady().then(() => {
  console.log("[main] app ready, argv:", process.argv);
  setStreamEventHandler((event) => {
    send("stream-event", event);
    send("log", { text: `[stream:${event.type}] ${JSON.stringify(event.part ?? {})}` });
  });

  const cwdIndex = process.argv.indexOf("--cwd");
  const projectDir = cwdIndex !== -1 && cwdIndex + 1 < process.argv.length
    ? resolve(process.cwd(), process.argv[cwdIndex + 1])
    : undefined;
  if (projectDir) {
    console.log("[main] project dir:", projectDir);
    setProjectDir(projectDir);
  }

  const adapterIndex = process.argv.indexOf("--adapter");
  const rawAdapterId = process.argv.find((a) => a.startsWith("--adapter="))?.split("=")[1]
    ?? (adapterIndex !== -1 && adapterIndex + 1 < process.argv.length ? process.argv[adapterIndex + 1] : undefined)
    ?? "opencode";

  const adapter = getAdapter(rawAdapterId);
  if (!adapter) {
    const errorMsg = `Unknown adapter "${rawAdapterId}". Available: ${BUILTIN_ADAPTERS.map((a) => a.id).join(", ")}`;
    console.error(`[main] ${errorMsg}`);
    dialog.showErrorBox("ORC Adapter Error", errorMsg);
    app.quit();
    return;
  }

  console.log("[main] adapter:", adapter.id);
  createWindow(adapter, projectDir);
});

app.on("window-all-closed", () => {
  ptyManager?.killAll();
  app.quit();
});

app.on("before-quit", () => {
  ptyManager?.killAll();
});
