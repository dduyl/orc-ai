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

export function createTerminal(container: HTMLElement): { term: Terminal; fit: () => void } {
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    theme: TERM_THEME,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  return {
    term,
    fit: () => {
      try {
        fitAddon.fit();
      } catch { /* ignore */ }
    },
  };
}