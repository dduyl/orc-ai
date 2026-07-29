export interface DomRefs {
  termContainer: HTMLElement;
  viewLabel: HTMLElement;
  statusIndicator: HTMLElement;
  statusText: HTMLElement;
  sbIndicator: HTMLElement;
  sbText: HTMLElement;
  termSize: HTMLElement;
  exitStatus: HTMLElement;
  infoAdapter: HTMLElement;
  infoStatus: HTMLElement;
  infoPid: HTMLElement;
  infoSize: HTMLElement;
  eventList: HTMLElement;
  stepTree: HTMLElement;
  ptyTree: HTMLElement;
  splitter: HTMLElement;
  rightPanel: HTMLElement;
}

export function getDomRefs(): DomRefs {
  const termContainer = document.getElementById("terminal");
  if (!termContainer) throw new Error("missing #terminal element");

  return {
    termContainer,
    viewLabel: document.getElementById("view-label")!,
    statusIndicator: document.getElementById("status-indicator")!,
    statusText: document.getElementById("status-text")!,
    sbIndicator: document.getElementById("sb-indicator")!,
    sbText: document.getElementById("sb-text")!,
    termSize: document.getElementById("term-size")!,
    exitStatus: document.getElementById("exit-status")!,
    infoAdapter: document.getElementById("info-adapter")!,
    infoStatus: document.getElementById("info-status")!,
    infoPid: document.getElementById("info-pid")!,
    infoSize: document.getElementById("info-size")!,
    eventList: document.getElementById("event-list")!,
    stepTree: document.getElementById("step-tree")!,
    ptyTree: document.getElementById("pty-tree")!,
    splitter: document.getElementById("splitter")!,
    rightPanel: document.getElementById("right-panel")!,
  };
}
