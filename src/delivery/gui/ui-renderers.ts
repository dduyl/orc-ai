import type { RunRecord, StepStatusRecord } from "../../application/harness/persistence/Tracker.js";
import type { StepInfo } from "./ipc.js";
export type { StepInfo };

/** Token colors mirrored from DESIGN.md (also see xterm theme in terminal.ts). */
const TOK = {
  ok: "#58d68d",
  err: "#ff6b6b",
  warn: "#ffb454",
  info: "#6bc9ff",
  faint: "#5d6b7a",
  text: "#e6edf3",
  secondary: "#9aa7b4",
} as const;

/** Threshold in px: while the user stays within this of the bottom, keep scrolling. */
const SCROLL_THRESHOLD = 80;

export function addEvent(text: string, container: HTMLElement): void {
  const entry = document.createElement("div");
  entry.className = "event-entry";
  entry.textContent = `› ${text}`;
  container.appendChild(entry);
  const nearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < SCROLL_THRESHOLD;
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

/** Split the terminal view label into a fixed tag and a live step context. */
export function setViewLabel(stepId: string, name: string, labelText: HTMLElement, labelStep: HTMLElement): void {
  labelText.textContent = "TERMINAL";
  if (stepId === "__main__") {
    labelStep.textContent = "· main";
  } else {
    labelStep.textContent = `· ${name}`;
  }
}

export function renderPTYTree(
  steps: StepInfo[],
  activeId: string | null,
  container: HTMLElement,
  onSelect: (stepId: string) => void,
): void {
  container.innerHTML = "";
  if (!steps.length) {
    container.innerHTML = '<div class="muted-empty">› No sessions</div>';
    return;
  }

  for (const s of steps) {
    const el = document.createElement("div");
    el.className = "step-entry" + (s.id === activeId ? " active" : "");
    const dotClass = s.isMain ? "main" : s.id === activeId ? "active" : "child";
    el.innerHTML = `<span class="step-dot ${dotClass}"></span><span class="step-label">${escapeHtml(s.name)}</span>`;
    el.addEventListener("click", () => onSelect(s.id));
    container.appendChild(el);
  }
}

export function renderStepTree(run: RunRecord, container: HTMLElement): void {
  container.innerHTML = "";
  if (!run || !run.steps) {
    container.innerHTML = '<div class="muted-empty">› No active run</div>';
    return;
  }

  const steps: StepStatusRecord[] = run.steps;
  const completed = steps.filter((s: any) => s.status === "completed").length;
  const failed = steps.filter((s: any) => s.status === "failed").length;
  const running = steps.filter((s: any) => s.status === "running").length;
  const pending = steps.filter((s: any) => s.status === "pending").length;

  const summary = document.createElement("div");
  summary.className = "info-row";
  summary.style.marginBottom = "6px";
  summary.innerHTML =
    `<span class="label">${escapeHtml(String(run.status))}</span>` +
    `<span class="value">${completed}✓ ${failed}✗ ${running}▶ ${pending}○</span>`;
  container.appendChild(summary);

  for (const step of steps) {
    const el = document.createElement("div");
    el.className = "info-row";
    el.style.fontSize = "11px";
    el.style.paddingLeft = "8px";

    let dot: string;
    let color: string = TOK.faint;
    switch (step.status) {
      case "completed": dot = "✓"; color = TOK.ok; break;
      case "failed": dot = "✗"; color = TOK.err; break;
      case "running": dot = "▶"; color = TOK.warn; break;
      default: dot = "○"; color = TOK.info; break;
    }

    const label = step.agent ? `${step.stepId} (${step.agent})` : step.stepId;
    const duration = step.duration ? `${step.duration}s` : "";
    el.innerHTML =
      `<span class="label"><span style="color:${color}">${dot}</span> ${escapeHtml(label)}</span>` +
      `<span class="value">${duration}</span>`;

    if (step.quota) {
      const quotaEl = document.createElement("div");
      quotaEl.className = "quota-banner";
      quotaEl.style.paddingLeft = "16px";
      quotaEl.style.color = TOK.warn;
      quotaEl.textContent =
        `[quota] ${step.quota.message}` +
        (step.quota.resetAtMs
          ? ` — paused until ${new Date(step.quota.resetAtMs).toLocaleString()}`
          : " — paused");
      container.appendChild(quotaEl);
    } else if (step.error) {
      const errEl = document.createElement("div");
      errEl.className = "event-entry";
      errEl.style.paddingLeft = "16px";
      errEl.style.color = TOK.err;
      errEl.textContent = step.error;
      container.appendChild(errEl);
    }

    container.appendChild(el);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}