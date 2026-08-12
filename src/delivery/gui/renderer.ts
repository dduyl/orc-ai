import { createTerminal } from "./terminal.js";
import { getDomRefs } from "./dom-refs.js";
import { ChatView } from "./chat-view.js";
import { addEvent, setViewLabel, renderPTYTree, renderStepTree, type StepInfo } from "./ui-renderers.js";
import { initSplitter } from "./splitter.js";

const MAIN_STEP_ID = "__main__";

/** Renderer-friendly view of an ACP chat frame (see daemon-bridge `ChatFrame`). */
type ChatFrame =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; call: { toolCallId: string; title: string } }
  | { kind: "tool_update"; update: { toolCallId: string; title?: string | null; name?: string | null; status?: string | null } }
  | { kind: "usage"; usage: { totalTokens: number; inputTokens: number; outputTokens: number } }
  | { kind: "turn"; stopReason: string }
  | { kind: "error"; message: string };

const api = (window as any).electronAPI as {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (code: number) => void) => void;
  onStatus: (cb: (data: Record<string, unknown>) => void) => void;
  onLog: (cb: (data: { text: string }) => void) => void;
  onStepActivated: (cb: (data: { stepId: string }) => void) => void;
  onRunActive: (cb: (data: { runId: string }) => void) => void;
  onPermissionRequested: (cb: (data: {
    requestId: string;
    toolCall: { title?: string | null; name?: string | null };
    options: { kind: string; name: string; optionId: string }[];
  }) => void) => void;
  onChatFrame: (cb: (data: { frame: ChatFrame }) => void) => void;
  write: (data: string) => void;
  prompt: (text: string) => void;
  cancelMain: () => void;
  answerPermission: (requestId: string, kind: string) => void;
  switchStep: (stepId: string) => Promise<void>;
  listSteps: () => Promise<StepInfo[]>;
  getStepOutput: (stepId: string) => Promise<string>;
  getRunStatus: (runId: string) => Promise<any>;
  listRuns: () => Promise<any[]>;
};

const refs = getDomRefs();
const { term, fit: fitTermBase } = createTerminal(refs.termContainer);
const chat = new ChatView(refs.chatList);

let latestRunId: string | null = null;
let currentStepId: string | null = MAIN_STEP_ID;
/** `pty` → bytes to a tty; `acp` → structured frames on the DOM chat panel. */
let mainMode: "pty" | "acp" = "pty";
let connected = false;
let busy = false;
let activeView: "chat" | "terminal" = "chat";

// ── View navigation ────────────────────────────────────────────────────────
function setActiveView(view: "chat" | "terminal"): void {
  activeView = view;
  const chatActive = view === "chat";
  refs.chatView.classList.toggle("active", chatActive);
  refs.terminalView.classList.toggle("visible", !chatActive);
  refs.tabChat.classList.toggle("active", chatActive);
  refs.tabTerminal.classList.toggle("active", !chatActive);
  if (chatActive) {
    refs.chatInput.focus();
  } else {
    fitTerm();
    term.focus();
  }
}

refs.tabChat.addEventListener("click", () => setActiveView("chat"));
refs.tabTerminal.addEventListener("click", () => setActiveView("terminal"));

// ── Session state ──────────────────────────────────────────────────────────
function setBusy(working: boolean, label?: string): void {
  busy = working;
  refs.chatBusy.hidden = !working;
  refs.chatBusyText.textContent = label ?? (working ? "Agent is working…" : "");
  refs.chatSend.disabled = !(connected && mainMode === "acp") || working;
  refs.chatInput.disabled = !(connected && mainMode === "acp") || working;
  if (connected) {
    refs.statusIndicator.className = working ? "status-dot idle" : "status-dot connected";
  }
}

function refreshTreeViews(): void {
  void refreshPTYTree();
  void pollRunStatus();
}

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

// ── Terminal sizing ────────────────────────────────────────────────────────
function fitTerm(): void {
  try {
    fitTermBase();
    const { cols, rows } = term;
    if (cols > 0 && rows > 0) {
      const size = `${cols}×${rows}`;
      refs.termSize.textContent = size;
      refs.infoSize.textContent = size;
    }
  } catch { /* ignore */ }
}

// ── Daemon events ──────────────────────────────────────────────────────────
api.onData((data: string) => {
  term.write(data);
});

api.onExit((code: number) => {
  connected = false;
  busy = false;
  refs.chatBusy.hidden = true;
  refs.statusIndicator.className = "status-dot disconnected";
  refs.statusText.textContent = `Exited (${code})`;
  refs.sbIndicator.className = "status-dot disconnected";
  refs.sbText.textContent = `Exited (${code})`;
  refs.exitStatus.textContent = `Exit: ${code}`;
  refs.infoStatus.textContent = `Exited (${code})`;
  refs.infoStatus.className = "value exited";
  addEvent(`Process exited with code ${code}`, refs.eventList);
  syncComposer();
});

api.onStatus((data: Record<string, unknown>) => {
  const type = data.type as string;
  if (type === "spawned") {
    mainMode = data.mode === "acp" ? "acp" : "pty";
    connected = true;
    refs.brandAdapter.textContent = ` · ${String(data.adapter ?? "opencode")}`;
    refs.statusIndicator.className = "status-dot connected";
    refs.statusText.textContent = mainMode === "acp" ? "Chat" : "Connected";
    refs.sbIndicator.className = "status-dot connected";
    refs.sbText.textContent = mainMode === "acp" ? "Chat" : "Connected";
    refs.infoAdapter.textContent = String(data.adapter ?? "—");
    refs.infoStatus.textContent = "Running";
    refs.infoStatus.className = "value running";
    refs.infoMode.textContent = mainMode;
    refs.infoPid.textContent = `${data.pid}`;
    addEvent(`Main terminal attached (${mainMode})`, refs.eventList);
    syncComposer();
  } else if (type === "error") {
    connected = false;
    refs.statusIndicator.className = "status-dot disconnected";
    refs.statusText.textContent = "Error";
    refs.sbIndicator.className = "status-dot disconnected";
    refs.sbText.textContent = "Error";
    addEvent(`ERROR: ${data.message}`, refs.eventList);
    syncComposer();
  } else if (type === "exited") {
    connected = false;
    busy = false;
    refs.chatBusy.hidden = true;
    refs.statusIndicator.className = "status-dot disconnected";
    refs.statusText.textContent = `Exited (${data.code})`;
    refs.sbIndicator.className = "status-dot disconnected";
    refs.sbText.textContent = `Exited (${data.code})`;
    refs.exitStatus.textContent = `Exit: ${data.code}`;
    refs.infoStatus.textContent = `Exited (${data.code})`;
    refs.infoStatus.className = "value exited";
    addEvent(`Process exited (code ${data.code})`, refs.eventList);
    syncComposer();
  }
});

api.onLog((data: { text: string }) => {
  addEvent(data.text, refs.eventList);
});

api.onRunActive((data: { runId: string }) => {
  latestRunId = data.runId;
  pollRunStatus();
});

api.onStepActivated(async (data: { stepId: string }) => {
  currentStepId = data.stepId;

  const isMain = data.stepId === MAIN_STEP_ID;
  const fullBuf = await api.getStepOutput(data.stepId);

  term.reset();
  term.write(fullBuf || "");
  setViewLabel(data.stepId, isMain ? "main" : data.stepId, refs.viewLabelText, refs.viewLabelStep);
  setActiveView(mainMode === "acp" && isMain ? "chat" : "terminal");
  refreshPTYTree();
  term.focus();
});

// ── Chat panel (ACP main) ──────────────────────────────────────────────────
api.onChatFrame((data) => {
  const frame = data.frame;
  switch (frame.kind) {
    case "text":
      chat.addText(frame.text);
      break;
    case "tool":
      chat.addTool(frame.call);
      break;
    case "tool_update":
      chat.addToolUpdate(frame.update);
      break;
    case "usage":
      chat.addUsage(frame.usage);
      break;
    case "turn":
      chat.addTurn(frame.stopReason as any);
      setBusy(false);
      break;
    case "error":
      chat.addError(frame.message);
      setBusy(false);
      break;
    case "user":
      chat.addUser(frame.text);
      break;
  }
});

function syncComposer(): void {
  refs.chatSend.disabled = !(connected && mainMode === "acp") || busy;
  refs.chatInput.disabled = !(connected && mainMode === "acp") || busy;
  if (activeView === "chat") refs.chatInput.focus();
}

function submitChat(): void {
  const text = refs.chatInput.value.trim();
  if (!text || !(connected && mainMode === "acp") || busy) return;
  chat.addUser(text);
  refs.chatInput.value = "";
  setBusy(true);
  api.prompt(text);
  refs.chatInput.focus();
}

refs.chatSend.addEventListener("click", submitChat);
refs.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitChat();
  }
});
refs.chatCancel.addEventListener("click", () => {
  api.cancelMain();
  setBusy(true, "Cancelling…");
});

// ── Permission dialog ──────────────────────────────────────────────────────
interface PermissionData {
  requestId: string;
  toolCall: { title?: string | null; name?: string | null };
  options: { kind: string; name: string; optionId: string }[];
}
/**
 * Incoming permission requests are queued and shown one at a time. Each answer
 * is correlated by `requestId`, so an overlapping request can never steal the
 * decision meant for the request on screen.
 */
const permissionQueue: PermissionData[] = [];
let activePermission: PermissionData | null = null;

function showNextPermission(): void {
  activePermission = permissionQueue.shift() ?? null;
  if (!activePermission) {
    refs.permissionDialog.classList.remove("visible");
    return;
  }
  const title = activePermission.toolCall.title ?? activePermission.toolCall.name ?? "tool";
  refs.permissionText.textContent = `Allow “${title}” to run?`;
  refs.permissionActions.innerHTML = "";
  const seen = new Set<string>();
  for (const opt of activePermission.options) {
    if (seen.has(opt.kind)) continue;
    seen.add(opt.kind);
    const btn = document.createElement("button");
    btn.className = "btn " + (opt.kind.startsWith("allow") ? "btn-allow" : "btn-reject");
    btn.textContent = opt.name;
    btn.addEventListener("click", () => answerPermission(opt.kind));
    refs.permissionActions.appendChild(btn);
  }
  if (!seen.has("reject_once") && !seen.has("reject_always")) {
    const btn = document.createElement("button");
    btn.className = "btn btn-reject";
    btn.textContent = "Reject";
    btn.addEventListener("click", () => answerPermission("reject_once"));
    refs.permissionActions.appendChild(btn);
  }
  setBusy(true, "Awaiting your decision…");
  refs.permissionDialog.classList.add("visible");
}

api.onPermissionRequested((data) => {
  permissionQueue.push(data);
  if (!activePermission) showNextPermission();
});

function answerPermission(kind: string): void {
  const current = activePermission;
  activePermission = null;
  if (current) {
    api.answerPermission(current.requestId, kind);
    addEvent(`Permission answered: ${kind}`, refs.eventList);
  }
  showNextPermission();
  if (!activePermission) setBusy(true);
}

// ── Keyboard routing ───────────────────────────────────────────────────────
term.onData((data: string) => {
  // In ACP-main the DOM chat panel owns composition; never send bytes to a chat.
  if (mainMode === "acp" && currentStepId === MAIN_STEP_ID) return;
  api.write(data);
});

// ── Boot ───────────────────────────────────────────────────────────────────
window.addEventListener("resize", fitTerm);
window.addEventListener("load", () => {
  setTimeout(() => {
    fitTerm();
    term.focus();
    setActiveView("chat");
  }, 50);
});
fitTerm();
startPolling();

initSplitter(refs.splitter, refs.termContainer, refs.rightPanel, fitTerm);