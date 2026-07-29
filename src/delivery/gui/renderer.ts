import { createTerminal } from "./terminal.js";
import { getDomRefs } from "./dom-refs.js";
import { addEvent, setViewLabel, renderPTYTree, renderStepTree, type StepInfo } from "./ui-renderers.js";
import { initSplitter } from "./splitter.js";

const api = (window as any).electronAPI as {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (code: number) => void) => void;
  onStatus: (cb: (data: Record<string, unknown>) => void) => void;
  onLog: (cb: (data: { text: string }) => void) => void;
  onStepActivated: (cb: (data: { stepId: string }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  switchStep: (stepId: string) => Promise<void>;
  listSteps: () => Promise<StepInfo[]>;
  getStepOutput: (stepId: string) => Promise<string>;
  getRunStatus: (runId: string) => Promise<any>;
  listRuns: () => Promise<any[]>;
};

const refs = getDomRefs();
const { term, fit: fitTermBase } = createTerminal(refs.termContainer);

let latestRunId: string | null = null;
let currentStepId: string | null = null;
const bufferCache = new Map<string, string>();

async function refreshPTYTree(): Promise<void> {
  try {
    const steps = await api.listSteps();
    renderPTYTree(steps, currentStepId, refs.ptyTree, (stepId) => {
      api.switchStep(stepId).catch(() => {});
    });
  } catch { /* ignore */ }
}

async function pollRunStatus(): Promise<void> {
  if (!latestRunId) return;
  try {
    const run = await api.getRunStatus(latestRunId);
    if (run) renderStepTree(run, refs.stepTree);
  } catch { /* ignore */ }
}

function startPolling(): void {
  setInterval(pollRunStatus, 2000);
  setInterval(refreshPTYTree, 2000);
}

function fitTerm(): void {
  try {
    fitTermBase();
    const { cols, rows } = term;
    if (cols > 0 && rows > 0) {
      api.resize(cols, rows);
      const size = `${cols}×${rows}`;
      refs.termSize.textContent = size;
      refs.infoSize.textContent = size;
    }
  } catch { /* ignore */ }
}

api.onData((data: string) => {
  term.write(data);
  const key = currentStepId || "__main__";
  if (!bufferCache.has(key)) bufferCache.set(key, "");
  bufferCache.set(key, bufferCache.get(key)! + data);
});

api.onExit((code: number) => {
  term.write(`\r\n\x1b[1;31m[process exited with code ${code}]\x1b[0m\r\n`);
  refs.statusIndicator.className = "status-dot disconnected";
  refs.statusText.textContent = `Exited (${code})`;
  refs.sbIndicator.className = "status-dot disconnected";
  refs.sbText.textContent = `Exited (${code})`;
  refs.exitStatus.textContent = `Exit: ${code}`;
  refs.infoStatus.textContent = `Exited (${code})`;
  refs.infoStatus.className = "value exited";
  addEvent(`Process exited with code ${code}`, refs.eventList);
});

api.onStatus((data: Record<string, unknown>) => {
  const type = data.type as string;
  if (type === "spawned") {
    refs.statusIndicator.className = "status-dot connected";
    refs.statusText.textContent = "Connected";
    refs.sbIndicator.className = "status-dot connected";
    refs.sbText.textContent = "Connected";
    refs.infoAdapter.textContent = data.adapter as string;
    refs.infoStatus.textContent = "Running";
    refs.infoStatus.className = "value running";
    refs.infoPid.textContent = `${data.pid}`;
    addEvent(`Main PTY spawned (pid ${data.pid})`, refs.eventList);
  } else if (type === "error") {
    refs.statusIndicator.className = "status-dot disconnected";
    refs.statusText.textContent = "Error";
    refs.sbIndicator.className = "status-dot disconnected";
    refs.sbText.textContent = "Error";
    addEvent(`ERROR: ${data.message}`, refs.eventList);
  } else if (type === "exited") {
    refs.statusIndicator.className = "status-dot disconnected";
    refs.statusText.textContent = `Exited (${data.code})`;
    refs.sbIndicator.className = "status-dot disconnected";
    refs.sbText.textContent = `Exited (${data.code})`;
    refs.exitStatus.textContent = `Exit: ${data.code}`;
    refs.infoStatus.textContent = `Exited (${data.code})`;
    refs.infoStatus.className = "value exited";
    addEvent(`Process exited (code ${data.code})`, refs.eventList);
  }
});

api.onLog((data: { text: string }) => {
  addEvent(data.text, refs.eventList);

  const m = data.text.match(/\[run ([0-9a-f-]+)\]/);
  if (m) {
    latestRunId = m[1];
    pollRunStatus();
  }
});

api.onStepActivated(async (data: { stepId: string }) => {
  currentStepId = data.stepId;

  const isMain = data.stepId === "__main__";
  const fullBuf = await api.getStepOutput(data.stepId);
  bufferCache.set(data.stepId, fullBuf || "");

  term.reset();
  term.write(fullBuf || "");

  setViewLabel(data.stepId, isMain ? "opencode" : data.stepId, refs.viewLabel);
  refreshPTYTree();
  term.focus();
});

term.onData((data: string) => api.write(data));

window.addEventListener("resize", fitTerm);
window.addEventListener("load", () => {
  setTimeout(() => {
    fitTerm();
    term.focus();
  }, 50);
});
fitTerm();
startPolling();

initSplitter(refs.splitter, refs.termContainer, refs.rightPanel, fitTerm);
