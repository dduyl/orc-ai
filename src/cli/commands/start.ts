import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as blessed from "blessed";
import { spawn } from "node-pty";
import type { AdapterDef } from "../../agents/adapter.js";

const _pkgRequire = createRequire(import.meta.url);
// pkg static-analysis hint: blessed's terminal.js requires term.js dynamically
if (false) { _pkgRequire("term.js"); }

export async function startAdapter(adapter: AdapterDef): Promise<void> {
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  }

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

  // HACK: blessed's TerminalElement.render ignores term.term.ydisp,
  // making scrollback invisible. Patch instance render to account for it.
  const t = term as any;
  t.render = function () {
    var ret = t._render();
    if (!ret) return;
    t.dattr = t.sattr(t.style);
    var xi = ret.xi + t.ileft, xl = ret.xl - t.iright,
      yi = ret.yi + t.itop, yl = ret.yl - t.ibottom, cursor,
      // FIX: scrollback = totalLines - visibleLines - (ybase - ydisp) so term.js's lines[screenY + ydisp] maps correctly
      scrollback = Math.max(0, term.term.lines.length - (yl - yi) - (term.term.ybase - term.term.ydisp));
    for (var y = Math.max(yi, 0); y < yl; y++) {
      var line = t.screen.lines[y];
      if (!line || !term.term.lines[scrollback + y - yi]) break;
      if (y === yi + term.term.y && term.term.cursorState
        && t.screen.focused === t
        && (term.term.ydisp === term.term.ybase || term.term.selectMode)
        && !term.term.cursorHidden) { cursor = xi + term.term.x; }
      else { cursor = -1; }
      for (var x = Math.max(xi, 0); x < xl; x++) {
        if (!line[x] || !term.term.lines[scrollback + y - yi][x - xi]) break;
        line[x][0] = term.term.lines[scrollback + y - yi][x - xi][0];
        if (x === cursor) {
          if (t.cursor === 'line') { line[x][0] = t.dattr; line[x][1] = '│'; continue; }
          else if (t.cursor === 'underline') line[x][0] = t.dattr | (2 << 18);
          else line[x][0] = t.dattr | (8 << 18);
        }
        line[x][1] = term.term.lines[scrollback + y - yi][x - xi][1];
        if (((line[x][0] >> 9) & 0x1ff) === 257)
          line[x][0] = (line[x][0] & ~(0x1ff << 9)) | (((t.dattr >> 9) & 0x1ff) << 9);
        if ((line[x][0] & 0x1ff) === 256)
          line[x][0] = (line[x][0] & ~0x1ff) | (t.dattr & 0x1ff);
      }
      line.dirty = true;
    }
    return ret;
  };

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
