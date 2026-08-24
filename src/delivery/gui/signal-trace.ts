import type { SignalEvent } from "../../core/workflow-graph.js";
import { escapeHtml } from "./html.js";

export class SignalTrace {
  private container: HTMLElement | null = null;
  private events: SignalEvent[] = [];
  private filterType: "all" | "emission" | "edge_match" | "gate_result" | "loop" = "all";
  private maxEvents = 200;

  mount(container: HTMLElement): void {
    this.container = container;
    container.innerHTML = `
      <div class="signal-trace-header" role="region" aria-label="Signal trace log">
        <span class="section-title">Signal Trace</span>
        <div class="signal-trace-filters" role="group" aria-label="Filter signal trace">
          <button class="filter-btn active" data-filter="all" aria-pressed="true">All</button>
          <button class="filter-btn" data-filter="emission" aria-pressed="false">Emissions</button>
          <button class="filter-btn" data-filter="edge_match" aria-pressed="false">Edges</button>
          <button class="filter-btn" data-filter="gate_result" aria-pressed="false">Gates</button>
          <button class="filter-btn" data-filter="loop" aria-pressed="false">Loops</button>
        </div>
      </div>
      <div class="signal-trace-entries" role="log"></div>
    `;

    const list = container.querySelector(".signal-trace-entries") as HTMLElement;
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
    // Prepend without rebuilding: keeps prior entry DOM nodes stable for
    // screen readers (role=log announces the new child only).
    const list = this.container?.querySelector(".signal-trace-entries") as HTMLElement;
    if (!list) return;
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(0, this.maxEvents);
    }
    if (!this.matchesFilter(event.type)) return;
    list.querySelector(".signal-trace-empty")?.remove();
    list.insertAdjacentHTML("afterbegin", this.renderEvent(event));
  }

  private setFilter(type: typeof this.filterType): void {
    this.filterType = type;
    this.container?.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach(btn => {
      const isActive = btn.dataset.filter === type;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
    this.render();
  }

  private matchesFilter(type: SignalEvent["type"]): boolean {
    return this.filterType === "all" || type === this.filterType;
  }

  private getFilteredEvents(): SignalEvent[] {
    if (this.filterType === "all") return this.events;
    return this.events.filter(e => this.matchesFilter(e.type));
  }

  private render(): void {
    if (!this.container) return;
    const list = this.container.querySelector(".signal-trace-entries") as HTMLElement;
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
    const stepId = escapeHtml(event.stepId);
    const signal = escapeHtml(event.signal ?? "");

    switch (event.type) {
      case "emission":
        icon = "▶";
        className = "signal-emission";
        text = `${stepId} emitted <strong>${signal}</strong>`;
        break;
      case "edge_match":
        icon = "⤷";
        className = "signal-edge";
        text = `${stepId}.${signal} → ${escapeHtml((event as { toStep?: string }).toStep ?? "")}`;
        break;
      case "gate_result": {
        icon = event.exitCode === 0 ? "✓" : "✗";
        className = `signal-gate ${event.exitCode === 0 ? "pass" : "fail"}`;
        const output = (event as { output?: string }).output ?? "";
        text = `Gate <strong>${escapeHtml(signal)}</strong> exit ${event.exitCode}${output ? ` — ${escapeHtml(output.slice(0, 80))}` : ""}`;
        break;
      }
      case "loop":
        icon = "⟳";
        className = "signal-loop";
        text = `Loop detected: ${stepId} iteration ${event.iteration} (from ${escapeHtml((event as { fromSignal?: string }).fromSignal ?? "")})`;
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