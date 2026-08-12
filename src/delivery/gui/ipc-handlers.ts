import { ipcMain } from "electron";
import type { DaemonBridge } from "./daemon-bridge.js";

export function registerIpcHandlers(bridge: DaemonBridge): void {
  ipcMain.on("input", (_event, data: string) => {
    void bridge.writeInput(data).catch(() => {});
  });

  ipcMain.on("prompt", (_event, text: string) => {
    void bridge.prompt(text).catch(() => {});
  });

  ipcMain.on("cancel-main", () => {
    void bridge.cancelMain().catch(() => {});
  });

  ipcMain.on("answer-permission", (_event, requestId: string, kind: string) => {
    void bridge
      .answerPermission(requestId, kind as "allow_once" | "allow_always" | "reject_once" | "reject_always")
      .catch(() => {});
  });

  ipcMain.handle("switch-step", (_event, stepId: string) => {
    bridge.switchToStep(stepId);
  });

  ipcMain.handle("list-steps", () => bridge.listSteps());

  ipcMain.handle("get-step-output", (_event, stepId: string) => bridge.getStepOutput(stepId));

  ipcMain.handle("start", (_event, task: string, workflowId: string) => bridge.startRun(task, workflowId));

  ipcMain.handle("get-run-status", (_event, runId: string) => bridge.getRunStatus(runId));

  ipcMain.handle("list-runs", () => bridge.listRuns());
}