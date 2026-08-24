import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/**
 * Terminal palette aligned to the Industrial Command Deck tokens (DESIGN.md).
 * The base stays a cold near-black so the amber accent and semantic colors
 * pop; grays map to the border/raised surfaces.
 */
export const TERM_THEME = {
  background: "#0b0e11",
  foreground: "#e6edf3",
  cursor: "#ffb454",
  cursorAccent: "#0b0e11",
  selectionBackground: "#31404e",
  black: "#232b34",
  red: "#ff6b6b",
  green: "#58d68d",
  yellow: "#ffb454",
  blue: "#6bc9ff",
  magenta: "#c792ea",
  cyan: "#73c7cf",
  white: "#e6edf3",
  brightBlack: "#5d6b7a",
  brightRed: "#ff8585",
  brightGreen: "#6ee19c",
  brightYellow: "#ffc97a",
  brightBlue: "#8cd4ff",
  brightMagenta: "#d3a6f2",
  brightCyan: "#8fd8de",
  brightWhite: "#ffffff",
} as const;

export interface StepTerminal {
  stepId: string;
  buffer: string;
  scrollTop: number;
}

export function createTerminal(container: HTMLElement): { 
  term: Terminal; 
  fit: () => void;
  stepTerminals: Map<string, StepTerminal>;
  setBuffer: (stepId: string, buffer: string) => void;
  getBuffer: (stepId: string) => string;
  saveStepState: (stepId: string) => void;
  restoreStepState: (stepId: string) => void;
  switchToStep: (stepId: string) => void;
} {
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    theme: TERM_THEME,
    scrollback: 10000,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  const stepTerminals = new Map<string, StepTerminal>();
  let currentStepId: string | null = null;

  function saveStepState(stepId: string): void {
    if (!currentStepId || currentStepId === stepId) return;
    try {
      // @ts-ignore - viewport is on renderer
      const viewport = term.renderer.viewport;
      stepTerminals.set(currentStepId, {
        stepId: currentStepId,
        buffer: getBuffer(currentStepId),
        scrollTop: viewport.scrollTop,
      });
    } catch { /* ignore */ }
  }

  function restoreStepState(stepId: string): void {
    const saved = stepTerminals.get(stepId);
    if (!saved) return;
    try {
      term.reset();
      term.write(saved.buffer);
      
      // @ts-ignore - viewport is on renderer
      const viewport = term.renderer.viewport;
      viewport.scrollTop = saved.scrollTop;
    } catch { /* ignore */ }
  }

  function setBuffer(stepId: string, buffer: string): void {
    if (!stepTerminals.has(stepId)) {
      stepTerminals.set(stepId, { stepId, buffer: "", scrollTop: 0 });
    }
    const existing = stepTerminals.get(stepId)!;
    existing.buffer = buffer;
  }

  function getBuffer(stepId: string): string {
    return stepTerminals.get(stepId)?.buffer || "";
  }

  function switchToStep(stepId: string): void {
    if (currentStepId) saveStepState(currentStepId);
    currentStepId = stepId;
    restoreStepState(stepId);
  }

  return {
    term,
    fit: () => {
      try {
        fitAddon.fit();
      } catch { /* ignore */ }
    },
    stepTerminals,
    setBuffer,
    getBuffer,
    saveStepState,
    restoreStepState,
    switchToStep,
  };
}