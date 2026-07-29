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
  onStreamEvent: (cb: (data: unknown) => void) => {
    ipcRenderer.on("stream-event", (_event, data) => cb(data));
  },
  write: (data: string) => ipcRenderer.send("input", data),
  resize: (cols: number, rows: number) => ipcRenderer.invoke("resize", cols, rows),
  switchStep: (stepId: string) => ipcRenderer.invoke("switch-step", stepId),
  listSteps: () => ipcRenderer.invoke("list-steps"),
  getStepOutput: (stepId: string) => ipcRenderer.invoke("get-step-output", stepId),
  getRunStatus: (runId: string) => ipcRenderer.invoke("get-run-status", runId),
  listRuns: () => ipcRenderer.invoke("list-runs"),
});
