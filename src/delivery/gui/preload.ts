import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  onData: (cb: (data: string) => void) => {
    ipcRenderer.on("output", (_event, data: string) => cb(data));
  },
  onExit: (cb: (code: number) => void) => {
    ipcRenderer.on("exit", (_event, code: number) => cb(code));
  },
  onStatus: (cb: (data: Record<string, unknown>) => void) => {
    ipcRenderer.on("status", (_event, data) => cb(data));
  },
  onLog: (cb: (data: { text: string }) => void) => {
    ipcRenderer.on("log", (_event, data) => cb(data));
  },
  onStepActivated: (cb: (data: { stepId: string }) => void) => {
    ipcRenderer.on("step-activated", (_event, data) => cb(data));
  },
  onRunActive: (cb: (data: { runId: string }) => void) => {
    ipcRenderer.on("run-active", (_event, data) => cb(data));
  },
  onPermissionRequested: (cb: (data: { requestId: string; toolCall: { title?: string | null; name?: string | null }; options: { kind: string; name: string; optionId: string }[] }) => void) => {
    ipcRenderer.on("permission-requested", (_event, data) => cb(data));
  },
  onChatFrame: (cb: (data: { frame: { kind: string } }) => void) => {
    ipcRenderer.on("chat-frame", (_event, data) => cb(data));
  },
  write: (data: string) => ipcRenderer.send("input", data),
  prompt: (text: string) => ipcRenderer.send("prompt", text),
  cancelMain: () => ipcRenderer.send("cancel-main"),
  answerPermission: (requestId: string, kind: string) => ipcRenderer.send("answer-permission", requestId, kind),
  switchStep: (stepId: string) => ipcRenderer.invoke("switch-step", stepId),
  listSteps: () => ipcRenderer.invoke("list-steps"),
  getStepOutput: (stepId: string) => ipcRenderer.invoke("get-step-output", stepId),
  start: (task: string, workflowId: string) => ipcRenderer.invoke("start", task, workflowId),
  getRunStatus: (runId: string) => ipcRenderer.invoke("get-run-status", runId),
  listRuns: () => ipcRenderer.invoke("list-runs"),
});