import { ipcMain } from "electron";
import type { PtyManager } from "./pty-manager.js";
import { queryRunStatus, listRunSummaries } from "./run-db.js";

export function registerIpcHandlers(ptyManager: PtyManager): void {
  ipcMain.handle("resize", (_event, cols: number, rows: number) => {
    ptyManager.resizeActive(cols, rows);
  });

  ipcMain.on("input", (_event, data: string) => {
    ptyManager.writeActive(data);
  });

  ipcMain.handle("switch-step", (_event, stepId: string) => {
    if (!ptyManager.listSteps().some(s => s.id === stepId)) return;
    ptyManager.switchToStep(stepId);
  });

  ipcMain.handle("list-steps", () => {
    return ptyManager.listSteps();
  });

  ipcMain.handle("get-step-output", (_event, stepId: string) => {
    return ptyManager.getBuffer(stepId);
  });

  ipcMain.handle("get-run-status", (_event, runId: string) => {
    return queryRunStatus(runId);
  });

  ipcMain.handle("list-runs", () => {
    return listRunSummaries();
  });
}
