import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

interface StepInfo {
  id: string;
  name: string;
  isActive: boolean;
  isMain: boolean;
}

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

/* ── xterm.js terminal ── */
const term = new Terminal({
  cursorBlink: true,
  cursorStyle: "block",
  fontSize: 14,
  fontFamily: "Consolas, 'Courier New', monospace",
  theme: {
    background: "#0d0d0d",
    foreground: "#f0f0f0",
    cursor: "#f0f0f0",
    selectionBackground: "#404040",
    black: "#2e3436",
    red: "#cc0000",
    green: "#4e9a06",
    yellow: "#c4a000",
    blue: "#3465a4",
    magenta: "#75507b",
    cyan: "#06989a",
    white: "#d3d7cf",
    brightBlack: "#555753",
    brightRed: "#ef2929",
    brightGreen: "#8ae234",
    brightYellow: "#fce94f",
    brightBlue: "#729fcf",
    brightMagenta: "#ad7fa8",
    brightCyan: "#34e2e2",
    brightWhite: "#eeeeec",
  },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

const termContainer = document.getElementById("terminal");
if (!termContainer) throw new Error("missing #terminal element");
term.open(termContainer);

const viewLabel = document.getElementById("view-label")!;

/* ── Status bar ── */
const statusIndicator = document.getElementById("status-indicator")!;
const statusText = document.getElementById("status-text")!;
const sbIndicator = document.getElementById("sb-indicator")!;
const sbText = document.getElementById("sb-text")!;
const termSize = document.getElementById("term-size")!;
const exitStatus = document.getElementById("exit-status")!;

/* ── Info panel ── */
const infoAdapter = document.getElementById("info-adapter")!;
const infoStatus = document.getElementById("info-status")!;
const infoPid = document.getElementById("info-pid")!;
const infoSize = document.getElementById("info-size")!;
const eventList = document.getElementById("event-list")!;
const stepTree = document.getElementById("step-tree")!;
const ptyTree = document.getElementById("pty-tree")!;

let latestRunId: string | null = null;
let currentStepId: string | null = null;

/* ── Buffer cache ── */
const bufferCache = new Map<string, string>();
let liveStepId: string | null = null;

function addEvent(text: string): void {
  const entry = document.createElement("div");
  entry.className = "event-entry";
  entry.textContent = `› ${text}`;
  eventList?.appendChild(entry);
  entry.scrollIntoView({ behavior: "smooth", block: "end" });
}

function setViewLabel(stepId: string, name: string): void {
  const prefix = stepId === "__main__" ? "" : "🔹 ";
  viewLabel.textContent = `Viewing: ${prefix}${name}`;
}

function renderPTYTree(steps: StepInfo[], activeId: string | null): void {
  ptyTree.innerHTML = "";
  if (!steps.length) {
    ptyTree.innerHTML = '<div class="event-entry">› No sessions</div>';
    return;
  }

  for (const s of steps) {
    const el = document.createElement("div");
    el.className = "step-entry" + (s.id === activeId ? " active" : "");
    const dotClass = s.isMain ? "main" : (s.id === activeId ? "active" : "child");
    el.innerHTML = `<span class="step-dot ${dotClass}"></span><span class="step-label">${s.name}</span>`;
    el.addEventListener("click", () => {
      api.switchStep(s.id).catch(() => {});
    });
    ptyTree.appendChild(el);
  }
}

async function refreshPTYTree(): Promise<void> {
  try {
    const steps = await api.listSteps();
    renderPTYTree(steps, currentStepId);
  } catch { /* ignore */ }
}

function renderStepTree(run: any): void {
  stepTree.innerHTML = "";
  if (!run || !run.steps) {
    stepTree.innerHTML = '<div class="event-entry">› No active run</div>';
    return;
  }

  const total = run.steps.length;
  const completed = run.steps.filter((s: any) => s.status === "completed").length;
  const failed = run.steps.filter((s: any) => s.status === "failed").length;
  const running = run.steps.filter((s: any) => s.status === "running").length;
  const pending = run.steps.filter((s: any) => s.status === "pending").length;

  const summary = document.createElement("div");
  summary.className = "info-row";
  summary.style.marginBottom = "6px";
  summary.style.fontSize = "11px";
  summary.innerHTML = `<span class="label">${run.status}</span><span class="value">${completed}✓ ${failed}✗ ${running}▶ ${pending}○</span>`;
  stepTree.appendChild(summary);

  for (const step of run.steps) {
    const el = document.createElement("div");
    el.className = "info-row";
    el.style.fontSize = "11px";
    el.style.paddingLeft = "8px";

    let dot = "○";
    let color = "#555";
    if (step.status === "completed") { dot = "✓"; color = "#8ae234"; }
    else if (step.status === "failed") { dot = "✗"; color = "#ef2929"; }
    else if (step.status === "running") { dot = "▶"; color = "#729fcf"; }

    const label = step.agent ? `${step.stepId} (${step.agent})` : step.stepId;
    const duration = step.duration ? `${step.duration}s` : "";
    el.innerHTML = `<span class="label"><span style="color:${color}">${dot}</span> ${label}</span><span class="value">${duration}</span>`;

    if (step.error) {
      const errEl = document.createElement("div");
      errEl.className = "event-entry";
      errEl.style.paddingLeft = "16px";
      errEl.style.color = "#ef2929";
      errEl.textContent = step.error;
      stepTree.appendChild(errEl);
    }

    stepTree.appendChild(el);
  }
}

async function pollRunStatus(): Promise<void> {
  if (!latestRunId) return;
  try {
    const run = await api.getRunStatus(latestRunId);
    if (run) renderStepTree(run);
  } catch { /* ignore */ }
}

function startPolling(): void {
  setInterval(pollRunStatus, 2000);
  setInterval(refreshPTYTree, 2000);
}

/* ── IPC handlers ── */
api.onData((data: string) => {
  term.write(data);
  const key = currentStepId || "__main__";
  if (!bufferCache.has(key)) bufferCache.set(key, "");
  bufferCache.set(key, bufferCache.get(key)! + data);
});

api.onExit((code: number) => {
  term.write(`\r\n\x1b[1;31m[process exited with code ${code}]\x1b[0m\r\n`);
  statusIndicator.className = "status-dot disconnected";
  statusText.textContent = `Exited (${code})`;
  sbIndicator.className = "status-dot disconnected";
  sbText.textContent = `Exited (${code})`;
  exitStatus.textContent = `Exit: ${code}`;
  infoStatus.textContent = `Exited (${code})`;
  infoStatus.className = "value exited";
  addEvent(`Process exited with code ${code}`);
});

api.onStatus((data: Record<string, unknown>) => {
  const type = data.type as string;
  if (type === "spawned") {
    statusIndicator.className = "status-dot connected";
    statusText.textContent = "Connected";
    sbIndicator.className = "status-dot connected";
    sbText.textContent = "Connected";
    infoAdapter.textContent = data.adapter as string;
    infoStatus.textContent = "Running";
    infoStatus.className = "value running";
    infoPid.textContent = `${data.pid}`;
    addEvent(`Main PTY spawned (pid ${data.pid})`);
  } else if (type === "error") {
    statusIndicator.className = "status-dot disconnected";
    statusText.textContent = "Error";
    sbIndicator.className = "status-dot disconnected";
    sbText.textContent = "Error";
    addEvent(`ERROR: ${data.message}`);
  } else if (type === "exited") {
    statusIndicator.className = "status-dot disconnected";
    statusText.textContent = `Exited (${data.code})`;
    sbIndicator.className = "status-dot disconnected";
    sbText.textContent = `Exited (${data.code})`;
    exitStatus.textContent = `Exit: ${data.code}`;
    infoStatus.textContent = `Exited (${data.code})`;
    infoStatus.className = "value exited";
    addEvent(`Process exited (code ${data.code})`);
  }
});

api.onLog((data: { text: string }) => {
  addEvent(data.text);

  const m = data.text.match(/\[run ([0-9a-f-]+)\]/);
  if (m) {
    latestRunId = m[1];
    pollRunStatus();
  }
});

api.onStepActivated(async (data: { stepId: string }) => {
  currentStepId = data.stepId;
  liveStepId = data.stepId;

  const isMain = data.stepId === "__main__";
  const fullBuf = await api.getStepOutput(data.stepId);
  bufferCache.set(data.stepId, fullBuf || "");

  term.reset();
  term.write(fullBuf || "");

  setViewLabel(data.stepId, isMain ? "opencode" : data.stepId);
  refreshPTYTree();
});

/* ── Input ── */
term.onData((data: string) => api.write(data));

/* ── Resize ── */
function fitTerm(): void {
  try {
    fitAddon.fit();
    const { cols, rows } = term;
    if (cols > 0 && rows > 0) {
      api.resize(cols, rows);
      const size = `${cols}×${rows}`;
      termSize.textContent = size;
      infoSize.textContent = size;
    }
  } catch { /* ignore */ }
}

window.addEventListener("resize", fitTerm);
window.addEventListener("load", () => setTimeout(fitTerm, 50));
fitTerm();
startPolling();

/* ── Drag-to-resize splitter ── */
const splitter = document.getElementById("splitter")!;
const rightPanel = document.getElementById("right-panel")!;
let dragging = false;

splitter.addEventListener("mousedown", (e) => {
  dragging = true;
  e.preventDefault();
});

document.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const splitX = e.clientX;
  const minLeft = 300;
  const maxRight = 200;
  const totalWidth = window.innerWidth;
  const leftWidth = Math.max(minLeft, Math.min(totalWidth - maxRight, splitX));
  termContainer.style.width = `${leftWidth - 2}px`;
  rightPanel.style.width = `${totalWidth - leftWidth - 2}px`;
  fitTerm();
});

document.addEventListener("mouseup", () => {
  dragging = false;
});