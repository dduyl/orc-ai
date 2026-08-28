import { escapeHtml } from "./html.js";

export interface StepListCallbacks {
  onSelect: (stepId: string) => void;
}

/** Normalized row shape fed by StepsView (derived from StepStatusRecord + definition). */
export interface StepRowData {
  stepId: string;
  agent?: string;
  status: "pending" | "running" | "completed" | "failed" | "needs_human";
  duration?: number | null;
  signals?: string[];
  isGate: boolean;
  /** Original declaration order in the workflow (stable sort key). */
  order: number;
}

export class StepList {
  private container: HTMLElement | null = null;
  private callbacks: StepListCallbacks;
  private steps: StepRowData[] = [];
  private filter: "all" | "running" | "failed" | "pending" = "all";
  private sortColumn: "order" | "status" | "duration" | "agent" = "order";
  private sortDirection: "asc" | "desc" = "asc";

  constructor(callbacks: StepListCallbacks) {
    this.callbacks = callbacks;
  }

  mount(container: HTMLElement): void {
    this.container = container;
    container.innerHTML = `
      <div class="step-list-header">
        <span class="section-title">Run Steps</span>
        <div class="step-list-filters" role="group" aria-label="Filter steps">
          <button class="filter-btn active" data-filter="all" aria-pressed="true">All</button>
          <button class="filter-btn" data-filter="running" aria-pressed="false">Running</button>
          <button class="filter-btn" data-filter="failed" aria-pressed="false">Failed</button>
          <button class="filter-btn" data-filter="pending" aria-pressed="false">Pending</button>
        </div>
      </div>
      <div class="step-list-table-wrapper">
        <table class="step-list-table">
          <thead>
            <tr>
              <th data-sort="order" aria-sort="ascending">Step</th>
              <th data-sort="agent">Agent</th>
              <th data-sort="status">Status</th>
              <th data-sort="duration">Duration</th>
              <th>Signals</th>
              <th>Gate</th>
            </tr>
          </thead>
          <tbody id="step-list-body"></tbody>
        </table>
      </div>
    `;

    container.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach(btn => {
      btn.addEventListener("click", () => this.setFilter(btn.dataset.filter as "all" | "running" | "failed" | "pending"));
    });

    container.querySelectorAll<HTMLTableHeaderCellElement>("th[data-sort]").forEach(th => {
      th.addEventListener("click", () => this.setSort(th.dataset.sort as "order" | "status" | "duration" | "agent"));
    });
  }

  unmount(): void {
    this.container = null;
    this.steps = [];
  }

  setSteps(steps: StepRowData[]): void {
    this.steps = steps;
    this.render();
  }

  /** Programmatically select a step row by id — highlights it and fires onSelect. */
  selectStep(stepId: string): void {
    if (!this.container) return;
    const row = this.container.querySelector(`tr[data-step-id="${stepId}"]`) as HTMLElement | null;
    this.clearSelection();
    if (row) {
      row.classList.add("step-selected");
      this.callbacks.onSelect(stepId);
    }
  }

  private clearSelection(): void {
    this.container?.querySelectorAll(".step-selected").forEach(el => el.classList.remove("step-selected"));
  }

  private setFilter(filter: typeof this.filter): void {
    this.filter = filter;
    this.container?.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach(btn => {
      const isActive = btn.dataset.filter === filter;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
    this.render();
  }

  private setSort(column: typeof this.sortColumn): void {
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
    } else {
      this.sortColumn = column;
      this.sortDirection = "asc";
    }
    this.syncSortIndicators();
    this.render();
  }

  private syncSortIndicators(): void {
    this.container?.querySelectorAll<HTMLTableHeaderCellElement>("th[data-sort]").forEach(th => {
      if (th.dataset.sort === this.sortColumn) {
        th.setAttribute("aria-sort", this.sortDirection === "asc" ? "ascending" : "descending");
      } else {
        th.removeAttribute("aria-sort");
      }
    });
  }

  private getFilteredSteps(): StepRowData[] {
    let filtered = this.steps;
    if (this.filter !== "all") {
      filtered = filtered.filter(s => s.status === this.filter);
    }

    filtered = [...filtered].sort((a, b) => {
      let aVal: any, bVal: any;
      switch (this.sortColumn) {
        case "order":
          aVal = a.order ?? 0;
          bVal = b.order ?? 0;
          break;
        case "status":
          aVal = a.status;
          bVal = b.status;
          break;
        case "duration":
          aVal = a.duration ?? 0;
          bVal = b.duration ?? 0;
          break;
        case "agent":
          aVal = a.agent ?? "";
          bVal = b.agent ?? "";
          break;
      }
      if (aVal < bVal) return this.sortDirection === "asc" ? -1 : 1;
      if (aVal > bVal) return this.sortDirection === "asc" ? 1 : -1;
      return 0;
    });

    return filtered;
  }

  private render(): void {
    if (!this.container) return;
    const tbody = this.container.querySelector("#step-list-body") as HTMLTableSectionElement;
    if (!tbody) return;

    const steps = this.getFilteredSteps();
    if (steps.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="step-list-empty">No steps</td></tr>';
      return;
    }

    tbody.innerHTML = steps.map(step => this.renderRow(step)).join("");

    tbody.querySelectorAll<HTMLElement>("tr[data-step-id]").forEach(row => {
      const select = () => {
        const stepId = row.getAttribute("data-step-id");
        if (stepId) this.callbacks.onSelect(stepId);
      };
      row.setAttribute("tabindex", "0");
      row.addEventListener("click", select);
      row.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        }
      });
    });
  }

  private renderRow(step: StepRowData): string {
    const statusClass = step.status;
    const statusGlyph = this.getStatusGlyph(step.status);
    const duration = step.duration != null ? `${step.duration}s` : "—";
    const signals = step.signals?.length ? step.signals.join(", ") : "—";
    const gate = step.isGate ? (step.status === "completed" ? "✓ pass" : step.status === "failed" ? "✗ fail" : "▶ running") : "—";
    const stepId = escapeHtml(step.stepId);
    const agent = step.agent ? escapeHtml(step.agent) : "—";

    return `
      <tr data-step-id="${stepId}" class="step-row ${statusClass}" aria-label="step ${stepId}, ${escapeHtml(step.status)}">
        <td>${stepId}</td>
        <td>${agent}</td>
        <td><span class="status-glyph ${statusClass}">${statusGlyph}</span> ${escapeHtml(step.status)}</td>
        <td>${duration}</td>
        <td>${escapeHtml(signals)}</td>
        <td class="gate-column">${gate}</td>
      </tr>
    `;
  }

  private getStatusGlyph(status: string): string {
    switch (status) {
      case "completed": return "✓";
      case "failed": return "✗";
      case "running": return "▶";
      default: return "○";
    }
  }
}