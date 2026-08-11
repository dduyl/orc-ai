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
  // layout
  splitter: HTMLElement;
  rightPanel: HTMLElement;
  // views + navigation
  chatView: HTMLElement;
  terminalView: HTMLElement;
  tabChat: HTMLButtonElement;
  tabTerminal: HTMLButtonElement;
  // chat panel
  chatList: HTMLElement;
  chatInput: HTMLInputElement;
  chatSend: HTMLButtonElement;
  chatBusy: HTMLElement;
  chatBusyText: HTMLElement;
  chatCancel: HTMLButtonElement;
  // permission dialog
  permissionDialog: HTMLElement;
  permissionText: HTMLElement;
  permissionHint: HTMLElement;
  permissionActions: HTMLElement;
  brandAdapter: HTMLElement;
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
    splitter: req("splitter"),
    rightPanel: req("right-panel"),
    chatView: req("chat-view"),
    terminalView: req("terminal-view"),
    tabChat: req("tab-chat") as HTMLButtonElement,
    tabTerminal: req("tab-terminal") as HTMLButtonElement,
    chatList: req("chat-list"),
    chatInput: req("chat-input") as HTMLInputElement,
    chatSend: req("chat-send") as HTMLButtonElement,
    chatBusy: req("chat-busy"),
    chatBusyText: req("chat-busy-text"),
    chatCancel: req("chat-cancel") as HTMLButtonElement,
    permissionDialog: req("permission-dialog"),
    permissionText: req("permission-text"),
    permissionHint: req("permission-hint"),
    permissionActions: req("permission-actions"),
    brandAdapter: req("brand-adapter"),
  };
}