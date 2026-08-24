export interface StepListCallbacks {
  onSelect: (stepId: string) => void;
}

export class StepList {
  private container: HTMLElement | null = null;
  private callbacks: StepListCallbacks;
  private steps: any[] = [];
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
        <div class="step-list-filters">
          <button class="filter-btn active" data-filter="all">All</button>
          <button class="filter-btn" data-filter="running">Running</button>
          <button class="filter-btn" data-filter="failed">Failed</button>
          <button class="filter-btn" data-filter="pending">Pending</button>
        </div>
      </div>
      <div class="step-list-table-wrapper">
        <table class="step-list-table">
          <thead>
            <tr>
              <th data-sort="order">Step</th>
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

  setSteps(steps: any[]): void {
    this.steps = steps;
    this.render();
  }

  private setFilter(filter: typeof this.filter): void {
    this.filter = filter;
    this.container?.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === filter);
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
    this.render();
  }

  private getFilteredSteps(): any[] {
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

    tbody.innerHTML = steps.map((step, idx) => this.renderRow(step, idx)).join("");

    tbody.querySelectorAll("tr[data-step-id]").forEach(row => {
      row.addEventListener("click", () => {
        const stepId = row.getAttribute("data-step-id");
        if (stepId) this.callbacks.onSelect(stepId);
      });
    });
  }

  private renderRow(step: any, idx: number): string {
    const statusClass = step.status;
    const statusGlyph = this.getStatusGlyph(step.status);
    const duration = step.duration != null ? `${step.duration}s` : "—";
    const signals = step.signals?.length ? step.signals.join(", ") : "—";
    const gate = step.isGate ? (step.status === "completed" ? "✓ pass" : step.status === "failed" ? "✗ fail" : "▶ running") : "—";

    return `
      <tr data-step-id="${step.stepId}" class="step-row ${statusClass}">
        <td>${step.stepId}</td>
        <td>${step.agent ?? "—"}</td>
        <td><span class="status-glyph ${statusClass}">${statusGlyph}</span> ${step.status}</td>
        <td>${duration}</td>
        <td>${signals}</td>
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