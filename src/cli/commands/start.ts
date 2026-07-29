import { join } from "node:path";
import { createRequire } from "node:module";
import * as blessed from "blessed";
import { spawn } from "node-pty";
import type { AdapterDef } from "../../agents/adapter.js";
import { loadDotEnv } from "../env-loader.js";
import { patchTerminalScrollback } from "../blessed-patch.js";

const _pkgRequire = createRequire(import.meta.url);
// pkg static-analysis hint: blessed's terminal.js requires term.js dynamically
if (false) { _pkgRequire("term.js"); }

export async function startAdapter(adapter: AdapterDef): Promise<void> {
  loadDotEnv();

  const cmd = adapter.command;
  const shell = process.platform === "win32"
    ? (process.env.COMSPEC || "cmd.exe")
    : cmd;
  const args = process.platform === "win32" ? ["/c", cmd] : [];

  const screen = blessed.screen({
    smartCSR: true,
    title: `ORC - ${adapter.id}`,
  });

  screen.program.enableMouse();

  let ptyWrite: ((data: string) => void) | undefined;

  const term = blessed.terminal({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    shell,
    args,
    handler: (input: Buffer) => ptyWrite?.(input.toString()),
    cursor: "block",
    cursorBlink: true,
    screenKeys: true,
  }) as blessed.Widgets.TerminalElement;

  patchTerminalScrollback(term);

  screen.on("mouse", (data) => {
    if (screen.focused !== term) return;
    // Don't scroll when the terminal app has enabled mouse tracking (vim, tmux, etc)
    const tmt = term.term;
    if (tmt.x10Mouse || tmt.vt200Mouse || tmt.normalMouse || tmt.mouseEvents
      || tmt.utfMouse || tmt.sgrMouse || tmt.urxvtMouse) return;
    if (data.action === "wheelup") term.term.scrollDisp(-3);
    else if (data.action === "wheeldown") term.term.scrollDisp(3);
  });

  const cols = term.term?.cols ?? 80;
  const rows = term.term?.rows ?? 24;

  const pty = spawn(shell, args, {
    cols,
    rows,
    name: "xterm-256color",
    cwd: process.cwd(),
    env: { ...process.env },
  });

  ptyWrite = (data: string) => pty.write(data);

  pty.onData((data: string) => {
    const offset = term.term.ybase - term.term.ydisp;
    term.write(data);
    term.term.ydisp = Math.max(0, term.term.ybase - offset);
    if (offset > 0) screen.render();
  });

  pty.onExit(({ exitCode }) => {
    screen.destroy();
    process.exit(exitCode ?? 0);
  });

  screen.on("resize", () => {
    const newCols = screen.cols;
    const newRows = screen.rows;
    try { pty.resize(newCols, newRows); } catch { /* PTY may be dead */ }
    if (term.term) term.term.resize(newCols, newRows);
  });

  screen.key(["pageup"], () => { term.term.scrollDisp(-(term.term.rows - 1)); });
  screen.key(["pagedown"], () => { term.term.scrollDisp(term.term.rows - 1); });

  screen.key(["C-q"], () => {
    pty.kill();
    screen.destroy();
    process.exit(0);
  });

  screen.render();
}
