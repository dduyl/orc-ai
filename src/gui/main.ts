import { app, BrowserWindow } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { McpServer } from "../mcp/server.js";
import { WorkflowRegistry } from "../planner/registry.js";
import type { ProgressEvent } from "../harness/orchestrator/index.js";
import { setStreamEventHandler } from "../stream/emitter.js";
import { PtyManager } from "./pty-manager.js";
import { registerIpcHandlers } from "./ipc-handlers.js";

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

function startEmbeddedMcp(): void {
  try {
    const registry = new WorkflowRegistry();
    const server = new McpServer(
      { id: "opencode", command: "opencode", label: "OpenCode AI Code Orchestrator" },
      registry,
      (event: ProgressEvent) => {
        if (event.type === "step_pty" && event.pty && event.stepId) {
          ptyManager.addSubagentPTY(event.stepId, event.pty, event.agent || event.stepId);
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

  ptyManager = new PtyManager(send, () => win, () => app.quit());
  registerIpcHandlers(ptyManager);

  win.loadFile(join(guiDir, "index.html"));

  win.once("ready-to-show", () => {
    console.log("[main] window ready-to-show, starting PTY + MCP");
    win?.show();
    ptyManager.spawnMainPTY(adapterId);
    startEmbeddedMcp();
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
  const adapterId = process.argv.find((a) => a.startsWith("--adapter="))?.split("=")[1]
    ?? process.argv[process.argv.indexOf("--adapter") + 1]
    ?? "opencode";
  console.log("[main] adapterId:", adapterId);
  createWindow(adapterId);
});

app.on("window-all-closed", () => {
  ptyManager?.killAll();
  app.quit();
});

app.on("before-quit", () => {
  ptyManager?.killAll();
});
