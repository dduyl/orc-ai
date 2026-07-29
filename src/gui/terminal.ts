import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export function createTerminal(container: HTMLElement): { term: Terminal; fit: () => void } {
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
