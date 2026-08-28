export interface DomRefs {
  // status + terminal
  termContainer: HTMLElement;
  viewLabelText: HTMLElement;
  viewLabelStep: HTMLElement;
  statusIndicator: HTMLElement;
  statusText: HTMLElement;
  sbIndicator: HTMLElement;
  sbText: HTMLElement;
  termSize: HTMLElement;
  exitStatus: HTMLElement;
  // inspector
  infoAdapter: HTMLElement;
  infoStatus: HTMLElement;
  infoMode: HTMLElement;
  infoPid: HTMLElement;
  infoSize: HTMLElement;
  eventList: HTMLElement;
  stepTree: HTMLElement;
  ptyTree: HTMLElement;
  // inspector new sections
  inspectorRun: HTMLElement;
  inspectorActiveStep: HTMLElement;
  inspectorSignalTrace: HTMLElement;
  signalTraceList: HTMLElement;
  // layout
  splitter: HTMLElement;
  rightPanel: HTMLElement;
  // views + navigation
  graphView: HTMLElement;
  stepsView: HTMLElement;
  stepsTableContainer: HTMLElement;
  chatView: HTMLElement;
  terminalView: HTMLElement;
  tabGraph: HTMLButtonElement;
  tabSteps: HTMLButtonElement;
  tabChat: HTMLButtonElement;
  tabTerminal: HTMLButtonElement;
  // chat panel
  chatScroll: HTMLElement;
  chatInput: HTMLInputElement;
  chatSend: HTMLButtonElement;
  chatMode: HTMLElement;
  chatModel: HTMLElement;
  chatModelMenu: HTMLElement;
  chatBusy: HTMLElement;
  chatBusyText: HTMLElement;
  chatCancel: HTMLButtonElement;
  chatSuggestions: HTMLElement;
  chatTabs: HTMLElement;
  brandAdapter: HTMLElement;
  // graph view
  graphViewContainer: HTMLElement;
  // workflow launcher
  btnNewRun: HTMLButtonElement;
}

function req(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} element`);
  return el;
}

export function getDomRefs(): DomRefs {
  return {
    termContainer: req("terminal"),
    viewLabelText: req("view-label-text"),
    viewLabelStep: req("view-label-step"),
    statusIndicator: req("status-indicator"),
    statusText: req("status-text"),
    sbIndicator: req("sb-indicator"),
    sbText: req("sb-text"),
    termSize: req("term-size"),
    exitStatus: req("exit-status"),
    infoAdapter: req("info-adapter"),
    infoStatus: req("info-status"),
    infoMode: req("info-mode"),
    infoPid: req("info-pid"),
    infoSize: req("info-size"),
    eventList: req("event-list"),
    stepTree: req("step-tree"),
    ptyTree: req("pty-tree"),
    inspectorRun: req("inspector-run"),
    inspectorActiveStep: req("inspector-active-step"),
    inspectorSignalTrace: req("inspector-signal-trace"),
    signalTraceList: req("signal-trace-list"),
    splitter: req("splitter"),
    rightPanel: req("right-panel"),
    graphView: req("graph-view"),
    stepsView: req("steps-view"),
    stepsTableContainer: req("steps-table-container"),
    chatView: req("chat-view"),
    terminalView: req("terminal-view"),
    tabGraph: req("tab-graph") as HTMLButtonElement,
    tabSteps: req("tab-steps") as HTMLButtonElement,
    tabChat: req("tab-chat") as HTMLButtonElement,
    tabTerminal: req("tab-terminal") as HTMLButtonElement,
    chatScroll: req("chat-scroll"),
    chatInput: req("chat-input") as HTMLInputElement,
    chatSend: req("chat-send") as HTMLButtonElement,
    chatMode: req("chat-mode"),
    chatModel: req("chat-model"),
    chatModelMenu: req("chat-model-menu"),
    chatBusy: req("chat-busy"),
    chatBusyText: req("chat-busy-text"),
    chatCancel: req("chat-cancel") as HTMLButtonElement,
    chatSuggestions: req("chat-suggestions"),
    chatTabs: req("chat-tabs"),
    brandAdapter: req("brand-adapter"),
    graphViewContainer: req("graph-view-container"),
    btnNewRun: req("btn-new-run") as HTMLButtonElement,
  };
}