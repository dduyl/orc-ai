import * as blessed from "blessed";
import type { Terminal as TerminalType } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { createRequire } from "node:module";

if (false) { require("@xterm/headless"); require("@xterm/addon-serialize"); }

const _require = createRequire(import.meta.url);
const Terminal: new (opts: Record<string, any>) => TerminalType = _require("@xterm/headless").Terminal as any;

const ESC = "\x1b";

function stripAnsi(s: string): string {
  const csiParam = "[\\x30-\\x3F]*";
  const csiInter = "[\\x20-\\x2F]*";
  const csiFinal = "[\\x40-\\x7E]";
  const csi = ESC + "\\[" + csiParam + csiInter + csiFinal;
  return s
    .replace(new RegExp(ESC + "\\].*?(?:\\x07|" + ESC + "\\\\)", "g"), "")
    .replace(new RegExp(csi, "g"), "")
    .replace(new RegExp(ESC + "[PX^_].*?" + ESC + "\\\\", "g"), "")
    .replace(new RegExp(ESC + "[\\x5b\\x5d\\x3d\\x28\\x29].?", "g"), "")
    .replace(new RegExp(ESC + "[NO\\x5c\\x5dZcg_^\\x7c~]", "g"), "")
    .replace(new RegExp(ESC + "c", "g"), "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export class OutputPanel {
  private box: blessed.Widgets.BoxElement;
  private xterm: TerminalType | null = null;
  private serializer: SerializeAddon | null = null;
  private buffer = "";
  private mode: "live" | "history" = "history";

  constructor(screen: blessed.Widgets.Screen) {
    this.box = blessed.box({
      parent: screen,
      top: 0,
      left: "30%",
      width: "70%",
      height: "100%-1",
      label: " Output ",
      border: { type: "line" },
      style: {
        fg: "white",
        border: { fg: "blue" },
        focus: { border: { fg: "cyan" } },
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: " " },
    });
  }

  initXterm(cols: number, rows: number): void {
    this.xterm = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.xterm.loadAddon(this.serializer);
    this.mode = "live";
  }

  write(text: string): void {
    this.buffer = text;
    this.box.setContent(text);
    this.box.setScrollPerc(100);
    if (this.xterm) {
      this.xterm.reset();
      this.xterm.write(text);
    }
  }

  append(ch: string): void {
    this.buffer += ch;
    this.box.setContent(this.buffer);
    this.box.setScrollPerc(100);
    if (this.xterm) {
      this.xterm.write(ch);
    }
  }

  feed(data: string): void {
    if (this.xterm) {
      this.xterm.write(data, () => {
        this.renderXterm();
      });
    }
  }

  resize(cols: number, rows: number): void {
    if (this.xterm) this.xterm.resize(cols, rows);
  }

  private renderXterm(): void {
    if (!this.xterm || !this.serializer || this.mode !== "live") return;
    try {
      const serialized = this.serializer.serialize();
      const cleaned = stripAnsi(serialized);
      this.buffer = cleaned;
      this.box.setContent(cleaned);
      this.box.setScrollPerc(100);
    } catch {
      // serialization may fail on empty buffer
    }
  }

  showHistory(text: string): void {
    this.mode = "history";
    this.box.setContent(text);
    this.box.setScrollPerc(100);
  }

  setLiveMode(): void {
    this.mode = "live";
  }

  isLiveMode(): boolean {
    return this.mode === "live";
  }

  getElement(): blessed.Widgets.BoxElement {
    return this.box;
  }

  focus(): void {
    this.box.focus();
  }

  destroy(): void {
    if (this.xterm) this.xterm.dispose();
    this.box.detach();
  }
}
