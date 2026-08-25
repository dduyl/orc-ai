import { api } from "../api.js";
import type { StepInfo } from "../ipc.js";

export class TerminalView {
  private container: HTMLElement | null = null;
  private stepSelect: HTMLSelectElement | null = null;
  /** Signature of the last rendered option set; identical input skips the rebuild. */
  private lastSignature = "";

  mount(container: HTMLElement): void {
    this.container = container;
    this.stepSelect = container.querySelector("#term-step-select") as HTMLSelectElement;
    if (this.stepSelect) {
      this.stepSelect.addEventListener("change", () => this.onStepChange());
    }
  }

  unmount(): void {
    this.container = null;
    this.stepSelect = null;
  }

  updateSteps(steps: StepInfo[]): void {
    if (!this.stepSelect) return;

    // The poll feeds this every 2s; rebuilding identical options would close
    // an open dropdown and reset selection, so skip when nothing changed.
    const signature = steps.map(s => `${s.id}:${s.isActive ? 1 : 0}`).join("|");
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const currentValue = this.stepSelect.value;
    const activeStep = steps.find(s => s.isActive);

    this.stepSelect.innerHTML = "";
    for (const step of steps) {
      const option = document.createElement("option");
      option.value = step.id;
      option.textContent = step.isMain ? "Main (orchestrator)" : step.name;
      if (step.isActive) option.selected = true;
      this.stepSelect.appendChild(option);
    }

    // Restore selection if possible
    if (steps.some(s => s.id === currentValue)) {
      this.stepSelect.value = currentValue;
    } else if (activeStep) {
      this.stepSelect.value = activeStep.id;
    }
  }

  private onStepChange(): void {
    const stepId = this.stepSelect?.value;
    if (stepId) {
      api.switchStep(stepId).catch(() => {});
    }
  }
}