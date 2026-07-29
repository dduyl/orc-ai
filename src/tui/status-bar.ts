import * as blessed from "blessed";

export class StatusBar {
  private box: blessed.Widgets.BoxElement;
  private stepLabel: string = "Steps: 0";
  private statusLabel: string = "Ready";
  private timerLabel: string = "00:00";
  private hintsLabel: string = "j/k ↑↓ nav  Enter focus  Esc tree  q quit";

  constructor(screen: blessed.Widgets.Screen) {
    this.box = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      style: { fg: "white", bg: "blue" },
      content: this.buildContent(),
    });
  }

  private buildContent(): string {
    return ` ${this.stepLabel}  |  ${this.statusLabel}  |  ${this.timerLabel}  |  ${this.hintsLabel} `;
  }

  updateSteps(active: number, total: number): void {
    this.stepLabel = `Steps: ${active}/${total}`;
    this.box.setContent(this.buildContent());
  }

  updateStatus(status: string): void {
    this.statusLabel = status;
    this.box.setContent(this.buildContent());
  }

  updateTimer(elapsed: number): void {
    const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
    const s = Math.floor(elapsed % 60).toString().padStart(2, "0");
    this.timerLabel = `${m}:${s}`;
    this.box.setContent(this.buildContent());
  }

  destroy(): void {
    this.box.detach();
  }
}
