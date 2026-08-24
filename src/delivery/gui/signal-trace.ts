import type { SignalEvent } from "../../core/workflow-graph.js";

export class SignalTrace {
  private container: HTMLElement | null = null;
  private events: SignalEvent[] = [];
  private filterType: "all" | "emission" | "edge_match" | "gate_result" | "loop" = "all";
  private maxEvents = 200;

  mount(container: HTMLElement): void {
    this.container = container;
    container.innerHTML = `
      <div class="signal-trace-header">
        <span class="section-title">Signal Trace</span>
        <div class="signal-trace-filters">
          <button class="filter-btn active" data-filter="all">All</button>
          <button class="filter-btn" data-filter="emission">Emissions</button>
          <button class="filter-btn" data-filter="edge_match">Edges</button>
          <button class="filter-btn" data-filter="gate_result">Gates</button>
          <button class="filter-btn" data-filter="loop">Loops</button>
        </div>
      </div>
      <div class="signal-trace-list" id="signal-trace-list"></div>
    `;

    const list = container.querySelector("#signal-trace-list") as HTMLElement;
    list.addEventListener("scroll", () => this.onScroll(list));

    container.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach(btn => {
      btn.addEventListener("click", () => this.setFilter(btn.dataset.filter as "all" | "emission" | "edge_match" | "gate_result" | "loop"));
    });
  }

  unmount(): void {
    this.container = null;
    this.events = [];
  }

  addEvent(event: SignalEvent): void {
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(0, this.maxEvents);
    }
    this.render();
  }

  private setFilter(type: typeof this.filterType): void {
    this.filterType = type;
    this.container?.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === type);
    });
    this.render();
  }

  private getFilteredEvents(): SignalEvent[] {
    if (this.filterType === "all") return this.events;
    return this.events.filter(e => e.type === this.filterType);
  }

  private render(): void {
    if (!this.container) return;
    const list = this.container.querySelector("#signal-trace-list") as HTMLElement;
    if (!list) return;

    const events = this.getFilteredEvents();
    if (events.length === 0) {
      list.innerHTML = '<div class="signal-trace-empty">Waiting for signals…</div>';
      return;
    }

    list.innerHTML = events.map(e => this.renderEvent(e)).join("");
  }

  private renderEvent(event: SignalEvent): string {
    const time = new Date(event.timestamp).toLocaleTimeString();
    let icon = "";
    let className = "";
    let text = "";

    switch (event.type) {
      case "emission":
        icon = "▶";
        className = "signal-emission";
        text = `${event.stepId} emitted <strong>${event.signal}</strong>`;
        break;
      case "edge_match":
        icon = "⤷";
        className = "signal-edge";
        text = `${event.stepId}.${event.signal} → ${(event as any).toStep}`;
        break;
      case "gate_result":
        icon = event.exitCode === 0 ? "✓" : "✗";
        className = `signal-gate ${event.exitCode === 0 ? "pass" : "fail"}`;
        text = `Gate <strong>${(event as any).gate}</strong> exit ${event.exitCode}${event.output ? ` — ${event.output.slice(0, 80)}` : ""}`;
        break;
      case "loop":
        icon = "⟳";
        className = "signal-loop";
        text = `Loop detected: ${event.stepId} iteration ${event.iteration} (from ${(event as any).fromSignal})`;
        break;
    }

    return `
      <div class="signal-trace-entry ${className}">
        <span class="signal-time">${time}</span>
        <span class="signal-icon">${icon}</span>
        <span class="signal-text">${text}</span>
      </div>
    `;
  }

  private onScroll(list: HTMLElement): void {
    // Auto-scroll pause on hover handled by CSS
  }
}