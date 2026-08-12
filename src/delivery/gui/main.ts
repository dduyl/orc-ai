import { app, BrowserWindow, dialog } from "electron";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { DaemonBridge, resolveGuiAdapter } from "./daemon-bridge.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import type { MainSender } from "./ipc.js";

/**
 * Electron GUI — pure pipe client (Phase D D-4).
 *
 * The GUI owns NO native resources: no embedded MCP server, no node-pty, no
 * SQLite. It spawns-or-attaches the daemon block over its control pipe and
 * streams terminal frames + run status back to the renderer. Quitting the GUI
 * never stops the daemon (D-2); the daemon outlives its clients.
 */

function getGuiDir(): string {
  const devDir = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(devDir, "index.html"))) return devDir;
  const exeDir = join(dirname(process.execPath), "gui");
  if (existsSync(join(exeDir, "index.html"))) return exeDir;
  return devDir;
}

const guiDir = getGuiDir();

let win: BrowserWindow | undefined;
let bridge: DaemonBridge | undefined;

const send: MainSender = (channel, data) => {
  if (win?.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, data);
  }
};

function createWindow(adapterId: string): BrowserWindow {
  const preloadPath = join(guiDir, "preload.js");

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 300,
    backgroundColor: "#0b0e11",
    title: `ORC — ${adapterId}`,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
    },
  });

  bridge = new DaemonBridge(send);
  registerIpcHandlers(bridge);
  win.loadFile(join(guiDir, "index.html"));

  win.once("ready-to-show", () => win?.show());

  win.on("closed", () => {
    win = undefined;
  });

  return win;
}

function parseArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.split("=").slice(1).join("=");
}

process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException swallowed:", err);
});

app.whenReady().then(async () => {
  console.log("[main] app ready, argv:", process.argv);
  const adapterId = resolveGuiAdapter(parseArg("adapter"));
  const projectDir = resolve(process.cwd(), parseArg("cwd") ?? "");

  createWindow(adapterId);

  try {
    await bridge!.connect(projectDir, adapterId);
    console.log("[main] connected to daemon");
  } catch (err: any) {
    console.error("[main] failed to connect to daemon:", err);
    dialog.showErrorBox("ORC Daemon Error", `Could not reach the run daemon.\n\n${err?.message ?? err}`);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  bridge?.dispose();
  app.quit();
});

app.on("before-quit", () => {
  bridge?.dispose();
});