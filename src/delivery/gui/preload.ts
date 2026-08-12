import { contextBridge, ipcRenderer } from "electron";
import { IPC, type GuiApi } from "./ipc.js";

const api: GuiApi = {
  onData: (cb) => {
    ipcRenderer.on(IPC.MainToRenderer.output, (_event, data) => cb(data));
  },
  onExit: (cb) => {
    ipcRenderer.on(IPC.MainToRenderer.exit, (_event, code) => cb(code));
  },
  onStatus: (cb) => {
    ipcRenderer.on(IPC.MainToRenderer.status, (_event, data) => cb(data));
  },
  onLog: (cb) => {
    ipcRenderer.on(IPC.MainToRenderer.log, (_event, data) => cb(data));
  },
  onStepActivated: (cb) => {
    ipcRenderer.on(IPC.MainToRenderer["step-activated"], (_event, data) => cb(data));
  },
  onRunActive: (cb) => {
    ipcRenderer.on(IPC.MainToRenderer["run-active"], (_event, data) => cb(data));
  },
  onPermissionRequested: (cb) => {
    ipcRenderer.on(IPC.MainToRenderer["permission-requested"], (_event, data) => cb(data));
  },
  onChatFrame: (cb) => {
    ipcRenderer.on(IPC.MainToRenderer["chat-frame"], (_event, data) => cb(data));
  },
  onChatReset: (cb) => {
    ipcRenderer.on(IPC.MainToRenderer["chat-reset"], () => cb());
  },
  write: (data) => ipcRenderer.send(IPC.RendererToMain.input, data),
  prompt: (text) => ipcRenderer.invoke(IPC.RendererToMainInvoke.prompt, text),
  cancelMain: () => ipcRenderer.send(IPC.RendererToMain["cancel-main"]),
  answerPermission: (requestId, kind) =>
    ipcRenderer.send(IPC.RendererToMain["answer-permission"], requestId, kind),
  switchStep: (stepId) => ipcRenderer.invoke(IPC.RendererToMainInvoke["switch-step"], stepId),
  listSteps: () => ipcRenderer.invoke(IPC.RendererToMainInvoke["list-steps"]),
  getStepOutput: (stepId) => ipcRenderer.invoke(IPC.RendererToMainInvoke["get-step-output"], stepId),
  start: (task, workflowId) => ipcRenderer.invoke(IPC.RendererToMainInvoke.start, task, workflowId),
  getRunStatus: (runId) => ipcRenderer.invoke(IPC.RendererToMainInvoke["get-run-status"], runId),
  listRuns: () => ipcRenderer.invoke(IPC.RendererToMainInvoke["list-runs"]),
};

contextBridge.exposeInMainWorld("electronAPI", api);