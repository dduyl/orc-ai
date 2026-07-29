import { app, BrowserWindow, ipcMain } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

function getGuiDir(): string {
  const devDir = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(devDir, "index.html"))) return devDir;
  const exeDir = join(dirname(process.execPath), "gui");
  if (existsSync(join(exeDir, "index.html"))) return exeDir;
  return devDir;
}

const guiDir = getGuiDir();

let win: BrowserWindow | undefined;

function send(channel: string, data: unknown): void {
  if (win?.webContents) {
    win.webContents.send(channel, data);
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
    win?.show();
  });

  win.on("closed", () => {
    win = undefined;
  });
}

app.whenReady().then(() => {
  createWindow("opencode");
});

app.on("window-all-closed", () => {
  app.quit();
});
