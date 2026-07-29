export interface StepInfo {
  id: string;
  name: string;
  isActive: boolean;
  isMain: boolean;
}

export function addEvent(text: string, container: HTMLElement): void {
  const entry = document.createElement("div");
  entry.className = "event-entry";
  entry.textContent = `› ${text}`;
  container.appendChild(entry);
  entry.scrollIntoView({ behavior: "smooth", block: "end" });
}

export function setViewLabel(stepId: string, name: string, label: HTMLElement): void {
  const prefix = stepId === "__main__" ? "" : "🔹 ";
  label.textContent = `Viewing: ${prefix}${name}`;
}

export function renderPTYTree(
  steps: StepInfo[],
  activeId: string | null,
  container: HTMLElement,
  onSelect: (stepId: string) => void,
): void {
  container.innerHTML = "";
  if (!steps.length) {
    container.innerHTML = '<div class="event-entry">› No sessions</div>';
    return;
  }

  for (const s of steps) {
    const el = document.createElement("div");
    el.className = "step-entry" + (s.id === activeId ? " active" : "");
    const dotClass = s.isMain ? "main" : (s.id === activeId ? "active" : "child");
    el.innerHTML = `<span class="step-dot ${dotClass}"></span><span class="step-label">${s.name}</span>`;
    el.addEventListener("click", () => onSelect(s.id));
    container.appendChild(el);
  }
}

export function renderStepTree(run: any, container: HTMLElement): void {
  container.innerHTML = "";
  if (!run || !run.steps) {
    container.innerHTML = '<div class="event-entry">› No active run</div>';
    return;
  }

  const total = run.steps.length;
  const completed = run.steps.filter((s: any) => s.status === "completed").length;
  const failed = run.steps.filter((s: any) => s.status === "failed").length;
  const running = run.steps.filter((s: any) => s.status === "running").length;
  const pending = run.steps.filter((s: any) => s.status === "pending").length;

  const summary = document.createElement("div");
  summary.className = "info-row";
  summary.style.marginBottom = "6px";
  summary.style.fontSize = "11px";
  summary.innerHTML = `<span class="label">${run.status}</span><span class="value">${completed}✓ ${failed}✗ ${running}▶ ${pending}○</span>`;
  container.appendChild(summary);

  for (const step of run.steps) {
    const el = document.createElement("div");
    el.className = "info-row";
    el.style.fontSize = "11px";
    el.style.paddingLeft = "8px";

    let dot = "○";
    let color = "#555";
    if (step.status === "completed") { dot = "✓"; color = "#8ae234"; }
    else if (step.status === "failed") { dot = "✗"; color = "#ef2929"; }
    else if (step.status === "running") { dot = "▶"; color = "#729fcf"; }

    const label = step.agent ? `${step.stepId} (${step.agent})` : step.stepId;
    const duration = step.duration ? `${step.duration}s` : "";
    el.innerHTML = `<span class="label"><span style="color:${color}">${dot}</span> ${label}</span><span class="value">${duration}</span>`;

    if (step.error) {
      const errEl = document.createElement("div");
      errEl.className = "event-entry";
      errEl.style.paddingLeft = "16px";
      errEl.style.color = "#ef2929";
      errEl.textContent = step.error;
      container.appendChild(errEl);
    }

    container.appendChild(el);
  }
}
