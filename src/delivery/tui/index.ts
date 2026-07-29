import * as blessed from "blessed";
import type { IPty } from "node-pty";
import { TreePanel } from "./tree.js";
import { OutputPanel } from "./output.js";
import { StatusBar } from "./status-bar.js";
import { log } from "../../core/log.js";
import { bindKeys } from "./key-handler.js";
import { bindStreamEvents } from "./stream-handler.js";

export type { TreeNodeData } from "./tree.js";

const ROOT_ID = "adapter";

export class Tui {
  screen: blessed.Widgets.Screen;
  tree: TreePanel;
  output: OutputPanel;
  status: StatusBar;
  private pty: IPty | null = null;
  private focusPanel: "tree" | "output" = "tree";
  private running = false;
  private stepCounters = { stepActiveCount: 0, stepTotalCount: 0 };
  private logs: string[] = [];

  constructor(adapterLabel: string) {
    log.setTeeToStderr(false);
    log.subscribe((entry) => this.pushLog(`[${entry.level.toUpperCase()}] ${entry.message}`));
    this.screen = blessed.screen({
      smartCSR: true,
      title: `ORC - ${adapterLabel}`,
      dockBorders: true,
      fullUnicode: true,
    });

    this.tree = new TreePanel(this.screen, adapterLabel, ROOT_ID);
    this.output = new OutputPanel(this.screen);
    this.status = new StatusBar(this.screen);

    this.tree.selectFirst();
    this.updateBorders();
    bindKeys(
      this.screen,
      this.tree,
      this.output,
      this.status,
      () => this.pty,
      () => this.focusPanel,
      (panel) => { this.focusPanel = panel; },
      () => this.updateBorders(),
      () => this.stop(),
    );
    bindStreamEvents(this.tree, this.output, this.status, this.screen, this.stepCounters);
  }

  private pushLog(msg: string): void {
    this.logs.push(msg);
  }

  getLogs(): string[] {
    return this.logs;
  }

  private updateBorders(): void {
    const tb = this.focusPanel === "tree" ? "cyan" : "blue";
    const ob = this.focusPanel === "output" ? "cyan" : "blue";
    this.tree.getElement().style.border = { fg: tb };
    this.output.getElement().style.border = { fg: ob };
    this.screen.render();
  }

  setPty(pty: IPty): void {
    this.pty = pty;
    const box = this.output.getElement();
    const cols = Math.max(20, (box.width as number) - 2 || 80);
    const rows = Math.max(5, (box.height as number) - 2 || 24);
    this.output.initXterm(cols, rows);
    pty.resize(cols, rows);
  }

  feedPtyData(data: string): void {
    this.output.feed(data);
  }

  resizePty(): void {
    if (!this.pty) return;
    const box = this.output.getElement();
    const cols = Math.max(20, (box.width as number) - 2 || 80);
    const rows = Math.max(5, (box.height as number) - 2 || 24);
    this.output.resize(cols, rows);
    this.pty.resize(cols, rows);
  }

  stop(): void {
    this.running = false;
    this.pty?.kill();
    this.tree.destroy();
    this.output.destroy();
    this.status.destroy();
    this.screen.destroy();
    process.exit(0);
  }

  start(): void {
    this.running = true;
    this.screen.render();

    const startTime = Date.now();
    const timer = setInterval(() => {
      if (!this.running) { clearInterval(timer); return; }
      this.status.updateTimer(Math.floor((Date.now() - startTime) / 1000));
      this.screen.render();
    }, 1000);

    setInterval(() => {
      if (this.running) this.screen.render();
    }, 50);
  }
}
