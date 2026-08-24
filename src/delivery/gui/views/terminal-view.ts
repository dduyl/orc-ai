import { api } from "../renderer.js";
import type { StepInfo } from "../ipc.js";

export class TerminalView {
  private container: HTMLElement | null = null;
  private stepSelect: HTMLSelectElement | null = null;

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