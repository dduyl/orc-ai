import { ipcMain } from "electron";
import type { DaemonBridge } from "./daemon-bridge.js";
import { IPC } from "./ipc.js";
import type { PermissionAnswerKind } from "../../application/agents/acp/types.js";
import type { PromptMention } from "./ipc.js";

export function registerIpcHandlers(bridge: DaemonBridge): void {
  ipcMain.on(IPC.RendererToMain.input, (_event, data: string) => {
    void bridge.writeInput(data).catch(() => {});
  });

ipcMain.handle(IPC.RendererToMainInvoke.prompt, (_event, text: string, mentions?: PromptMention[]) => {
    // invoke (not fire-and-forget): the renderer clears its busy state when the
    // prompt round-trip rejects (e.g. the main ACP session is closed), instead
    // of hanging in "working…" with no `turn`/`error` frame to unblock it.
    return bridge.prompt(text, mentions);
  });

  ipcMain.on(IPC.RendererToMain["cancel-main"], () => {
    void bridge.cancelMain().catch(() => {});
  });

  ipcMain.on(IPC.RendererToMain["answer-permission"], (_event, requestId: string, kind: PermissionAnswerKind) => {
    void bridge.answerPermission(requestId, kind).catch(() => {});
  });

  ipcMain.handle(IPC.RendererToMainInvoke["switch-step"], (_event, stepId: string) => {
    bridge.switchToStep(stepId);
  });

  ipcMain.handle(IPC.RendererToMainInvoke["list-steps"], () => bridge.listSteps());

  ipcMain.handle(IPC.RendererToMainInvoke["get-step-output"], (_event, stepId: string) => bridge.getStepOutput(stepId));

  ipcMain.handle(IPC.RendererToMainInvoke.start, (_event, task: string, workflowId: string) =>
    bridge.startRun(task, workflowId),
  );

  ipcMain.handle(IPC.RendererToMainInvoke["get-run-status"], (_event, runId: string) => bridge.getRunStatus(runId));

  ipcMain.handle(IPC.RendererToMainInvoke["list-runs"], () => bridge.listRuns());

  ipcMain.handle(IPC.RendererToMainInvoke["set-config-option"], (_event, configId: string, value: string) =>
    bridge.setConfigOption(configId, value),
  );
}