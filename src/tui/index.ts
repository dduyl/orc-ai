import * as blessed from "blessed";
import type { IPty } from "node-pty";
import { TreePanel } from "./tree.js";
import { OutputPanel } from "./output.js";
import { StatusBar } from "./status-bar.js";
import type { StreamEvent } from "../stream/types.js";
import { setStreamEventHandler } from "../stream/emitter.js";
import { log } from "../log.js";
import type { TreeNodeData } from "./tree.js";

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
  private stepActiveCount = 0;
  private stepTotalCount = 0;
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
    this.setupKeys();
    this.setupStreamEvents();
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

  private setupKeys(): void {
    this.screen.on("keypress", (_ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
      if (!key || !key.name) return;

      if (key.name === "q") {
        this.confirmQuit();
        return;
      }

      if (this.focusPanel === "tree") {
        if (key.name === "j" || key.name === "down") {
          this.tree.getElement().down(1);
          this.screen.render();
          return;
        }
        if (key.name === "k" || key.name === "up") {
          this.tree.getElement().up(1);
          this.screen.render();
          return;
        }
        if (key.name === "enter") {
          const selectedId = this.tree.getSelectedId();
          if (!selectedId) return;
          if (selectedId === ROOT_ID) {
            this.focusPanel = "output";
            this.output.setLiveMode();
            this.output.write("-- ORC Live Output --\n");
            this.updateBorders();
          } else {
            this.output.showHistory(this.tree.getOutput(selectedId));
            this.screen.render();
          }
          return;
        }
        return;
      }

      if (this.focusPanel === "output") {
        if (key.name === "escape") {
          this.focusPanel = "tree";
          this.output.setLiveMode();
          this.updateBorders();
          return;
        }
        if (this.pty && this.output.isLiveMode() && this.tree.isRootSelected()) {
          const seq = key.sequence || _ch || "";
          this.pty.write(seq);
          if (key.name === "enter") {
            this.output.append("\n");
          } else if (key.name === "backspace") {
            this.output.append("\b \b");
          } else if (_ch && _ch.length === 1 && _ch >= " ") {
            this.output.append(_ch);
          }
        }
        return;
      }
    });
  }

  private setupStreamEvents(): void {
    setStreamEventHandler((event: StreamEvent) => {
      if (event.type === "step_start") {
        this.stepActiveCount++;
        this.stepTotalCount = Math.max(this.stepTotalCount, this.stepActiveCount);
        this.tree.addNode(ROOT_ID, event.part.id, event.part.snapshot.slice(0, 40));
        this.tree.updateStatus(event.part.id, "running");
        this.status.updateSteps(this.stepActiveCount, this.stepTotalCount);
        this.status.updateStatus(`Running: ${event.part.id}`);
        this.screen.render();
      } else if (event.type === "text") {
        this.tree.updateOutput(event.part.id, event.part.text);
        if (this.tree.getSelectedId() === event.part.id && !this.tree.isRootSelected()) {
          this.output.showHistory(event.part.text);
          this.screen.render();
        }
      } else if (event.type === "step_finish") {
        this.stepActiveCount = Math.max(0, this.stepActiveCount - 1);
        const status: TreeNodeData["status"] = event.part.reason === "stop" ? "completed"
          : event.part.reason === "build_failed" ? "failed"
          : event.part.reason === "error" || event.part.reason === "max_retries" ? "failed"
          : event.part.reason === "budget_exceeded" || event.part.reason === "loop_detected" ? "failed"
          : "failed";
        this.tree.updateStatus(event.part.id, status);
        this.status.updateSteps(this.stepActiveCount, this.stepTotalCount);
        this.status.updateStatus(status === "completed" ? "Step completed" : `Step ${status}`);
        this.screen.render();
      }
    });
  }

  private confirmQuit(): void {
    this.status.updateStatus("Press q again to quit, any other key to cancel");
    this.screen.render();

    const handler = (_ch: any, key: any) => {
      if (key && key.name === "q") {
        this.screen.removeListener("keypress", handler);
        this.stop();
        return;
      }
      this.screen.removeListener("keypress", handler);
      this.status.updateStatus("Ready");
      this.screen.render();
    };
    this.screen.on("keypress", handler);
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
