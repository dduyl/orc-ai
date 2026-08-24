import { StepList } from "../step-list.js";
import { api } from "../renderer.js";

export class StepsView {
  private stepList: StepList;
  private container: HTMLElement | null = null;

  constructor() {
    this.stepList = new StepList({
      onSelect: (stepId) => this.onStepSelect(stepId),
    });
  }

  mount(container: HTMLElement): void {
    this.container = container;
    this.stepList.mount(container);
  }

  unmount(): void {
    this.stepList.unmount();
    this.container = null;
  }

  setStepStatus(steps: any[]): void {
    this.stepList.setSteps(steps.map((s, idx) => ({
      stepId: s.stepId,
      agent: s.agent,
      status: s.status,
      duration: s.duration,
      signals: s.signals ?? [],
      isGate: s.isGate ?? (s.type === "script"),
      order: idx,
    })));
  }

  private onStepSelect(stepId: string): void {
    api.switchStep(stepId).catch(() => {});
  }
}