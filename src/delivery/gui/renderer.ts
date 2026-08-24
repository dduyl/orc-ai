import { createTerminal } from "./terminal.js";
import { getDomRefs } from "./dom-refs.js";
import { ChatView } from "./chat-view.js";
import { ActivityBox } from "./activity-box.js";
import { MentionBox, type SuggestionItem } from "./mention-box.js";
import { GraphView } from "./views/graph-view.js";
import { StepsView } from "./views/steps-view.js";
import { SignalTrace } from "./signal-trace.js";
import { ActiveStep } from "./active-step.js";
import { addEvent, setViewLabel, renderPTYTree, renderStepTree, type StepInfo } from "./ui-renderers.js";
import { initSplitter } from "./splitter.js";
import { GUIDE_TEXT } from "../../adapters/mcp/handlers/content.js";
import type { AgentCommand, AgentConfigOption } from "../../application/harness/daemon/main-frame-codec.js";
import type { ChatFrame, CustomMode, PromptMention, SignalEvent } from "./ipc.js";

const MAIN_STEP_ID = "__main__";

export const api = window.electronAPI;

const refs = getDomRefs();
const { term, fit: fitTermBase } = createTerminal(refs.termContainer);
const chat = new ChatView(refs.chatList);
const graphView = new GraphView();
const stepsView = new StepsView();
const signalTrace = new SignalTrace();
const activeStep = new ActiveStep();
const activity = new ActivityBox({
  box: refs.activityBox,
  permissionSection: refs.permissionSection,
  permissionText: refs.permissionText,
  permissionHint: refs.permissionHint,
  permissionActions: refs.permissionActions,
  permissionNav: refs.permissionNav,
  permissionPrev: refs.permissionPrev,
  permissionNext: refs.permissionNext,
  permissionCounter: refs.permissionCounter,
  toolsSection: refs.toolsSection,
  toolList: refs.toolList,
  onAnswer: (requestId, kind) => {
    api.answerPermission(requestId, kind);
    addEvent(`Permission answered: ${kind}`, refs.eventList);
    setBusy(true, activity.hasPending() ? "Awaiting your decision…" : undefined);
  },
});

let latestRunId: string | null = null;
let currentStepId: string | null = MAIN_STEP_ID;
/** `pty` → bytes to a tty; `acp` → structured frames on the DOM chat panel. */
let mainMode: "pty" | "acp" = "pty";
let connected = false;
let busy = false;
let activeView: "graph" | "steps" | "chat" | "terminal" = "graph";

// ── Composer mention + command picker (local fs walk / ACP commands) ────────
let suggestionGen = 0;
let activeToken: { kind: "file" | "command"; start: number; end: number; text: string } | null = null;
let commandCache: AgentCommand[] = [];

type CommandGroupId = "cmd" | "skill" | "other";
const GROUP_LABEL: Record<CommandGroupId, string> = { cmd: "cmd", skill: "skill", other: "other" };

/** Sentinel values the picker routes internally instead of splicing. */
const GROUP_SENTINEL = "\u0000group:";
const BACK_SENTINEL = "\u0000back";

/**
 * opencode's ACP `available_commands_update` strips the command `source`, so the
 * renderer groups `/` commands itself: a builtin allowlist → `cmd`, commands
 * matching an installed skill dir → `skill`, everything else (config commands,
 * MCP prompts) → `other`.
 */
const BUILTIN_COMMANDS = new Set([
  "agent", "bug", "chat", "compact", "export", "help", "init", "mode", "model",
  "new", "plan", "prompt", "redo", "resume", "review", "share", "undo",
]);

let skillNames = new Set<string>();
let commandGroup: CommandGroupId | null = null;

function commandGroupOf(c: AgentCommand): CommandGroupId {
  const name = c.name.toLowerCase();
  if (BUILTIN_COMMANDS.has(name)) return "cmd";
  if (skillNames.has(name) || /skill/i.test(c.description)) return "skill";
  return "other";
}

function commandGroups(): { id: CommandGroupId; commands: AgentCommand[] }[] {
  const buckets: Record<CommandGroupId, AgentCommand[]> = { cmd: [], skill: [], other: [] };
  for (const c of commandCache) buckets[commandGroupOf(c)].push(c);
  return (["cmd", "skill", "other"] as CommandGroupId[]).map((id) => ({ id, commands: buckets[id] }));
}

function commandMatches(c: AgentCommand, q: string): boolean {
  return (
    !q ||
    c.name.toLowerCase().startsWith(q) ||
    c.name.toLowerCase().includes(q) ||
    c.description.toLowerCase().includes(q)
  );
}

const suggestionBox = new MentionBox(refs.chatSuggestions, (value) => {
  if (value === BACK_SENTINEL) {
    commandGroup = null;
    void refreshSuggestions();
    return;
  }
  const groupMatch = value.startsWith(GROUP_SENTINEL) ? value.slice(GROUP_SENTINEL.length) : null;
  if (groupMatch === "cmd" || groupMatch === "skill" || groupMatch === "other") {
    commandGroup = groupMatch;
    void refreshSuggestions();
    return;
  }
  const input = refs.chatInput;
  const token = activeToken;
  if (!token) return;
  input.value = input.value.slice(0, token.start) + value + input.value.slice(token.end);
  const caret = token.start + value.length;
  input.setSelectionRange(caret, caret);
  // A picked command closes the popover (the trailing space lets the user type
  // an argument) and resets the drill level so the next `/` shows groups again;
  // a picked mention may expand into a deeper directory walk.
  if (token.kind === "command") {
    commandGroup = null;
    return;
  }
  void refreshSuggestions();
});

/**
 * Detect a completion token ending at the caret: a leading `/` slash command
 * (only when the slash starts the line) or an `@path` mention (line start /
 * after whitespace).
 */
function detectToken(): { kind: "file" | "command"; start: number; end: number; text: string } | null {
  const input = refs.chatInput;
  const value = input.value;
  const caret = input.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  // Leading `/` only — mid-word slashes (e.g. "path/a/b") must not trigger it.
  const slash = before.match(/^\/([^\s]*)$/);
  if (slash) {
    return { kind: "command", start: caret - slash[0].length, end: caret, text: slash[1] };
  }
  const at = before.match(/(?:^|\s)@([^\s]*)$/);
  if (at) {
    const atPos = caret - at[0].length + at[0].lastIndexOf("@");
    return { kind: "file", start: atPos, end: caret, text: at[1] };
  }
  return null;
}

/** Re-evaluate the composer state and repaint the file/command popover. */
async function refreshSuggestions(): Promise<void> {
  const gen = ++suggestionGen;
  const token = detectToken();
  if (!token) {
    activeToken = null;
    commandGroup = null;
    suggestionBox.hide();
    return;
  }
  activeToken = token;
  if (token.kind === "command") {
    const q = token.text.toLowerCase();
    const groups = commandGroups();
    const nonEmpty = groups.filter((g) => g.commands.length > 0);
    const items: SuggestionItem[] = [];

    if (q === "" && commandGroup === null && nonEmpty.length > 1) {
      // `/` with a real cmd/skill/other mix → show the groups first; picking one drills in.
      for (const g of nonEmpty) {
        items.push({
          value: `${GROUP_SENTINEL}${g.id}`,
          name: g.id,
          kind: "group",
          description: `${g.commands.length} command${g.commands.length === 1 ? "" : "s"}`,
        });
      }
    } else if (q === "" && commandGroup === null) {
      // Single group (or none) → flat items, unchanged from before.
      for (const c of nonEmpty[0]?.commands ?? []) {
        items.push({
          value: `/${c.name} `,
          name: `/${c.name}`,
          kind: "command" as const,
          meta: GROUP_LABEL[commandGroupOf(c)],
          description: c.description,
        });
      }
    } else {
      // Drilled into a group, or a type-ahead query → matching items (back row when drilled).
      if (commandGroup !== null) {
        items.push({ value: BACK_SENTINEL, name: "‹ all groups", kind: "back" });
      }
      const pool =
        commandGroup !== null
          ? groups.find((g) => g.id === commandGroup)?.commands ?? []
          : commandCache;
      for (const c of pool.filter((cc) => commandMatches(cc, q)).slice(0, 12)) {
        items.push({
          value: `/${c.name} `,
          name: `/${c.name}`,
          kind: "command" as const,
          meta: GROUP_LABEL[commandGroupOf(c)],
          description: c.description,
        });
      }
    }

    if (gen !== suggestionGen) return;
    if (items.length === 0)
      suggestionBox.showEmpty(commandGroup !== null ? "No commands in this group" : "No commands available");
    else suggestionBox.show(items);
    return;
  }
  try {
    const result = await api.findFiles(token.text);
    const items: SuggestionItem[] = result.entries.slice(0, 12).map((e) => {
      const isDir = e.type === "directory";
      const full = result.dir ? `${result.dir}/${e.name}` : e.path;
      return { name: e.name, value: `@${full}${isDir ? "/" : ""}`, kind: isDir ? "dir" : "file" };
    });
    if (gen !== suggestionGen) return;
    suggestionBox.show(items);
  } catch {
    if (gen !== suggestionGen) return;
    suggestionBox.hide();
  }
}

// ── Composer modes (normal / workflow / custom) ─────────────────────────────
type ComposerMode = "normal" | "workflow" | "custom";
const MODE_LABEL: Record<Exclude<ComposerMode, "custom">, string> = {
  normal: "normal",
  workflow: "workflow · guide",
};

let composerMode: ComposerMode = "normal";
let customModes: CustomMode[] = [];

/** Ordered Tab cycle: normal → workflow → custom (only when custom modes exist) → normal. */
function modeCycle(modes: CustomMode[]): ComposerMode[] {
  return ["normal", "workflow", ...(modes.length > 0 ? (["custom"] as ComposerMode[]) : [])];
}

function cycleMode(): void {
  const order = modeCycle(customModes);
  composerMode = order[(order.indexOf(composerMode) + 1) % order.length];
  renderModeBadge();
}

/** The instruction block prepended to the next prompt in this mode. */
function modeGuide(mode: ComposerMode): string {
  if (mode === "workflow") return GUIDE_TEXT;
  if (mode === "custom") return customModes[0]?.content ?? "";
  return "";
}

function renderModeBadge(): void {
  const badge = refs.chatMode;
  const guide = modeGuide(composerMode);
  badge.textContent =
    composerMode === "custom"
      ? `custom · ${customModes[0]?.name ?? "?"}`
      : MODE_LABEL[composerMode];
  const preview = guide.trim().replace(/\s+/g, " ").slice(0, 200);
  badge.title = preview
    ? `${composerMode} mode — prepend: ${preview}…`
    : `${composerMode} mode — plain chat, nothing prepended`;
  badge.classList.toggle("active", composerMode !== "normal");
}

refs.chatMode.addEventListener("click", cycleMode);
renderModeBadge();

// ── Model picker (session config options from ACP) ──────────────────────────
let configOptions: AgentConfigOption[] = [];
let modelMenuOpen = false;

/** The model selector, when the agent advertises one (`category`/id/name). */
function modelOption(): AgentConfigOption | undefined {
  return (
    configOptions.find((o) => o.category === "model") ??
    configOptions.find((o) => o.id === "model") ??
    configOptions.find((o) => o.name === "Model")
  );
}

function renderModelBadge(): void {
  const model = modelOption();
  if (!model || model.type !== "select") {
    refs.chatModel.hidden = true;
    closeModelMenu();
    return;
  }
  const current = model.options?.find((o) => o.value === model.currentValue);
  refs.chatModel.textContent = current?.name ?? String(model.currentValue ?? "model");
  refs.chatModel.title = current ? `Model: ${current.name}` : "Model";
  refs.chatModel.hidden = false;
}

function renderModelLabel(label: string): void {
  refs.chatModel.textContent = label;
}

function toggleModelMenu(): void {
  if (modelMenuOpen) {
    closeModelMenu();
    return;
  }
  const model = modelOption();
  if (!model || model.type !== "select") return;
  const menu = refs.chatModelMenu;
  menu.replaceChildren();
  for (const choice of model.options ?? []) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "model-opt";
    if (choice.value === model.currentValue) row.classList.add("active");
    row.textContent = choice.name;
    row.title = choice.name;
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", () => {
      closeModelMenu();
      void setModel(choice.value, choice.name);
    });
    menu.appendChild(row);
  }
  menu.classList.add("visible");
  modelMenuOpen = true;
}

function closeModelMenu(): void {
  refs.chatModelMenu.classList.remove("visible");
  refs.chatModelMenu.replaceChildren();
  modelMenuOpen = false;
}

/** Switch the agent model. Optimistic badge update, reverted on failure. */
async function setModel(value: string, label: string): Promise<void> {
  const model = modelOption();
  if (!model) return;
  const prev = model.options?.find((o) => o.value === model.currentValue)?.name ?? String(model.currentValue ?? "");
  renderModelLabel(label);
  try {
    await api.setConfigOption(model.id, value);
  } catch (err) {
    // The config frame from the daemon normally confirms the new value; on a
    // rejected round-trip revert the badge and surface the failure.
    renderModelLabel(prev);
    const message = err instanceof Error ? err.message : String(err);
    addEvent(`Model switch failed: ${message}`, refs.eventList);
  }
}

refs.chatModel.addEventListener("click", toggleModelMenu);
document.addEventListener("click", (e) => {
  if (
    modelMenuOpen &&
    !refs.chatModel.contains(e.target as Node) &&
    !refs.chatModelMenu.contains(e.target as Node)
  ) {
    closeModelMenu();
  }
});

refs.tabChat.addEventListener("click", () => setActiveView("chat"));
refs.tabTerminal.addEventListener("click", () => setActiveView("terminal"));
refs.tabGraph.addEventListener("click", () => setActiveView("graph"));
refs.tabSteps.addEventListener("click", () => setActiveView("steps"));

// Mount GraphView
graphView.mount(refs.graphViewContainer);

// Mount StepsView
stepsView.mount(refs.stepsView);

// Mount SignalTrace
signalTrace.mount(refs.signalTraceList);

// Mount ActiveStep
activeStep.mount(refs.inspectorActiveStep);

// ── View navigation ────────────────────────────────────────────────────────
function setActiveView(view: "graph" | "steps" | "chat" | "terminal"): void {
  activeView = view;
  const isGraph = view === "graph";
  const isSteps = view === "steps";
  const isChat = view === "chat";
  const isTerminal = view === "terminal";

  refs.graphView.classList.toggle("active", isGraph);
  refs.stepsView.classList.toggle("active", isSteps);
  refs.chatView.classList.toggle("active", isChat);
  refs.terminalView.classList.toggle("visible", isTerminal);

  refs.tabGraph.classList.toggle("active", isGraph);
  refs.tabSteps.classList.toggle("active", isSteps);
  refs.tabChat.classList.toggle("active", isChat);
  refs.tabTerminal.classList.toggle("active", isTerminal);

  if (isGraph) {
    graphView.fitToView();
  } else if (isSteps) {
    // Steps view is already rendered via pollRunStatus
  } else if (isChat) {
    refs.chatInput.focus();
  } else if (isTerminal) {
    fitTerm();
    term.focus();
  }
}

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
    if (run) {
      renderStepTree(run, refs.stepTree);
      updateStepTreeFromRun(run);
    }
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

api.onStatus((data) => {
  if (data.type === "spawned") {
    mainMode = data.mode === "acp" ? "acp" : "pty";
    connected = true;
    commandGroup = null;
    suggestionBox.hide();
    composerMode = "normal";
    // A fresh main session resets its advertised commands + config options.
    commandCache = [];
    configOptions = [];
    closeModelMenu();
    renderModelBadge();
    void api
      .getCustomModes()
      .then((modes) => {
        customModes = modes;
        renderModeBadge();
      })
      .catch(() => {
        customModes = [];
        renderModeBadge();
      });
    void api
      .listSkills()
      .then((names) => {
        skillNames = new Set(names);
      })
      .catch(() => {
        skillNames = new Set();
      });
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
  } else if (data.type === "error") {
    connected = false;
    refs.statusIndicator.className = "status-dot disconnected";
    refs.statusText.textContent = "Error";
    refs.sbIndicator.className = "status-dot disconnected";
    refs.sbText.textContent = "Error";
    addEvent(`ERROR: ${data.message}`, refs.eventList);
    syncComposer();
  } else if (data.type === "exited") {
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

api.onWorkflowStarted((data: { runId: string; workflowId: string; workflow: any }) => {
  latestRunId = data.runId;
  graphView.init(data.workflow);
  setActiveView("graph");
});

api.onWorkflowComplete((data: { runId: string; status: "completed" | "failed"; finalSignal?: string }) => {
  addEvent(`Workflow ${data.status} (${data.finalSignal ?? "—"})`, refs.eventList);
  if (data.runId === latestRunId) {
    graphView.setStepStatus([]);
    activeStep.render({ stepId: "", agent: "", context: [], emits: [] });
  }
});

api.onSignalEmitted((data: { stepId: string; signal: string; payload?: unknown; timestamp: number }) => {
  const event: SignalEvent = { ...data, type: "emission" };
  graphView.onSignalEmitted(event);
  signalTrace.addEvent(event);
});

api.onEdgeMatched((data: { fromStep: string; signal: string; toStep: string; timestamp: number }) => {
  const event: SignalEvent = { ...data, type: "edge_match", stepId: data.fromStep };
  graphView.onEdgeMatched(event);
  signalTrace.addEvent(event);
});

api.onGateResult((data: { stepId: string; gate: string; exitCode: number; output: string }) => {
  const event: SignalEvent = { ...data, type: "gate_result", stepId: data.stepId, signal: data.gate, timestamp: Date.now() };
  signalTrace.addEvent(event);
});

api.onLoopDetected((data: { stepId: string; iteration: number; reason: string; fromSignal: string }) => {
  const event: SignalEvent = { ...data, type: "loop", stepId: data.stepId, signal: data.fromSignal, timestamp: Date.now() };
  signalTrace.addEvent(event);
});

api.onStepContext((data: { stepId: string; agent: string; context: string[]; emits: string[] }) => {
  activeStep.render(data);
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

  graphView.onStepActivated(data.stepId);
  stepsView.setStepStatus([]); // Will be updated by pollRunStatus
});

// ── Chat panel (ACP main) ──────────────────────────────────────────────────
api.onChatReset(() => {
  chat.clear();
  activity.clear();
});

api.onChatFrame((data) => {
  const frame = data.frame;
  switch (frame.kind) {
    case "text":
      chat.addText(frame.text);
      break;
    case "tool":
      activity.addTool(frame.call);
      break;
    case "tool_update":
      activity.addToolUpdate(frame.update);
      break;
    case "usage":
      chat.addUsage(frame.usage);
      break;
    case "turn":
      chat.addTurn(frame.stopReason);
      setBusy(false);
      break;
    case "error":
      chat.addError(frame.message);
      setBusy(false);
      break;
    case "user":
      chat.addUser(frame.text);
      break;
    case "commands":
      commandCache = frame.commands;
      break;
    case "config":
      configOptions = frame.options;
      renderModelBadge();
      break;
  }
});

function syncComposer(): void {
  refs.chatSend.disabled = !(connected && mainMode === "acp") || busy;
  refs.chatInput.disabled = !(connected && mainMode === "acp") || busy;
  if (activeView === "chat") refs.chatInput.focus();
}

function updateStepTreeFromRun(run: any): void {
  if (!run || !run.steps) return;
  graphView.setStepStatus(run.steps);
}

/** Pull `@path` mentions out of a composer value, leaving the rest as text. */
function extractMentions(raw: string): { text: string; mentions: PromptMention[] } {
  const mentions: PromptMention[] = [];
  const text = raw.replace(/(?:^|\s)@([^\s]+)/g, (_m, path: string) => {
    mentions.push({ path });
    return "";
  });
  return { text: text.trim(), mentions };
}

function submitChat(): void {
  if (!(connected && mainMode === "acp") || busy) return;
  const raw = refs.chatInput.value;
  const { text, mentions } = extractMentions(raw);
  if (!text) return;
  // Active composer mode prepends an instruction block to the prompt. Mentions
  // are extracted from the raw composer value, so the guide is added after the
  // `@path` tokens are resolved (the guide never needs mention expansion).
  // A leading-slash line runs an agent command verbatim — never prepend the guide.
  const guide = modeGuide(composerMode);
  const final = guide && !text.startsWith("/") ? `${guide.trim()}\n\n${text}` : text;
  commandGroup = null;
  suggestionBox.hide();
  chat.addUser(text);
  refs.chatInput.value = "";
  setBusy(true);
  api
    .prompt(final, mentions)
    .catch((err) => {
      // A rejected prompt round-trip means the turn never started (e.g. the main
      // session is closed): no `turn`/`error` frame will arrive to unblock the
      // composer, so clear busy here and surface the failure in the chat.
      setBusy(false);
      const message = err instanceof Error ? err.message : String(err);
      chat.addError(message);
    })
    .finally(() => refs.chatInput.focus());
}

refs.chatSend.addEventListener("click", submitChat);
refs.chatInput.addEventListener("input", () => {
  void refreshSuggestions();
});
refs.chatInput.addEventListener("keydown", (e) => {
  if (suggestionBox.visible && suggestionBox.interactive) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      suggestionBox.move(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      suggestionBox.move(-1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      suggestionBox.pick();
      return;
    }
  }
  if (suggestionBox.visible && e.key === "Escape") {
    e.preventDefault();
    if (commandGroup !== null && detectToken()?.kind === "command") {
      // Drill-in: Escape pops back to the group list instead of closing.
      commandGroup = null;
      void refreshSuggestions();
    } else {
      suggestionBox.hide();
    }
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    submitChat();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    cycleMode();
  }
});
refs.chatInput.addEventListener("blur", () => {
  commandGroup = null;
  suggestionBox.hide();
});
refs.chatCancel.addEventListener("click", () => {
  api.cancelMain();
  setBusy(true, "Cancelling…");
});

// ── Permission requests → activity box ─────────────────────────────────────
api.onPermissionRequested((data) => {
  activity.addPermission(data);
  setBusy(true, "Awaiting your decision…");
});

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