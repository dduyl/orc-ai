import { contextBridge, ipcRenderer } from "electron";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, normalize, relative } from "node:path";
import { IPC, type CustomMode, type FsEntry, type FsFindResult, type GuiApi } from "./ipc.js";

/**
 * Workspace root for the local `@`-mention fs walk. Main passes it via
 * `webPreferences.additionalArguments` (`--orc-cwd=<projectDir>`) so the
 * renderer's picker never talks to the agent's HTTP server (Phase 5 v2).
 */
function workspaceCwd(): string {
  const arg = process.argv.find((a) => a.startsWith("--orc-cwd="));
  return arg ? arg.slice("--orc-cwd=".length) : process.cwd();
}

/** Normalize `a/b/..`-style traversal so a mention path can't escape cwd. */
function withinCwd(cwd: string, target: string): string {
  const resolved = normalize(target);
  const base = normalize(cwd);
  if (resolved === base) return base;
  if (resolved.startsWith(base + "\\") || resolved.startsWith(base + "/")) return resolved;
  return base;
}

/** Read a directory's immediate children as `FsEntry`s. */
async function readEntries(cwd: string, dir: string): Promise<FsEntry[]> {
  try {
    const target = withinCwd(cwd, dir ? join(cwd, dir) : cwd);
    const dirents = await fs.readdir(target, { withFileTypes: true });
    return dirents.map((d) => {
      const rel = relative(cwd, join(target, d.name)).replace(/\\/g, "/");
      return {
        name: d.name,
        path: rel,
        absolute: join(target, d.name),
        type: d.isDirectory() ? "directory" : "file",
      };
    });
  } catch {
    return [];
  }
}

/** Skill directories opencode auto-loads (workspace + home). */
function skillRoots(): string[] {
  const home = homedir();
  const cwd = workspaceCwd();
  return [
    join(cwd, ".claude", "skills"),
    join(cwd, ".agents", "skills"),
    join(cwd, ".opencode", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".config", "opencode", "skills"),
  ];
}

/** Collect skill names from dirs that contain a `SKILL.md`. */
async function readSkillNames(): Promise<string[]> {
  const names = new Set<string>();
  for (const dir of skillRoots()) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await fs.access(join(dir, entry.name, "SKILL.md"));
        names.add(entry.name);
      } catch {
        /* no SKILL.md — not a skill */
      }
    }
  }
  return [...names];
}

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
  prompt: (text, mentions) => ipcRenderer.invoke(IPC.RendererToMainInvoke.prompt, text, mentions),
  cancelMain: () => ipcRenderer.send(IPC.RendererToMain["cancel-main"]),
  answerPermission: (requestId, kind) =>
    ipcRenderer.send(IPC.RendererToMain["answer-permission"], requestId, kind),
  switchStep: (stepId) => ipcRenderer.invoke(IPC.RendererToMainInvoke["switch-step"], stepId),
  listSteps: () => ipcRenderer.invoke(IPC.RendererToMainInvoke["list-steps"]),
  getStepOutput: (stepId) => ipcRenderer.invoke(IPC.RendererToMainInvoke["get-step-output"], stepId),
  start: (task, workflowId) => ipcRenderer.invoke(IPC.RendererToMainInvoke.start, task, workflowId),
  getRunStatus: (runId) => ipcRenderer.invoke(IPC.RendererToMainInvoke["get-run-status"], runId),
  listRuns: () => ipcRenderer.invoke(IPC.RendererToMainInvoke["list-runs"]),
  setConfigOption: (configId, value) =>
    ipcRenderer.invoke(IPC.RendererToMainInvoke["set-config-option"], configId, value),
  findFiles: async (query: string): Promise<FsFindResult> => {
    const cwd = workspaceCwd();
    const text = query.replace(/\\/g, "/");
    if (text.length === 0) return { entries: await readEntries(cwd, "") };
    const slashIdx = text.lastIndexOf("/");
    if (slashIdx >= 0) {
      const dir = text.slice(0, slashIdx);
      const prefix = text.slice(slashIdx + 1);
      const entries = (await readEntries(cwd, dir)).filter((e) =>
        (e.name || e.path).toLowerCase().startsWith(prefix.toLowerCase()),
      );
      return { entries, dir };
    }
    const entries = (await readEntries(cwd, "")).filter((e) =>
      (e.name || e.path).toLowerCase().startsWith(text.toLowerCase()),
    );
    return { entries };
  },
  listDir: (path: string): Promise<FsEntry[]> => readEntries(workspaceCwd(), path),
  getCustomModes: async (): Promise<CustomMode[]> => {
    try {
      const modesDir = join(homedir(), ".orc", "modes");
      const names = (await fs.readdir(modesDir)).filter((n) => /\.(md|markdown)$/i.test(n)).sort();
      const modes: CustomMode[] = [];
      for (const name of names) {
        const content = await fs.readFile(join(modesDir, name), "utf8");
        modes.push({ name: basename(name).replace(/\.(md|markdown)$/i, ""), content });
      }
      return modes;
    } catch {
      return [];
    }
  },
  listSkills: () => readSkillNames(),
};

contextBridge.exposeInMainWorld("electronAPI", api);