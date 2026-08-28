import { StepList, type StepRowData } from "../step-list.js";
import type { StepStatusRecord } from "../../../application/harness/persistence/Tracker.js";
import { api } from "../api.js";

export interface StepsViewCallbacks {
  onStepSelect?: (stepId: string) => void;
}

export class StepsView {
  private stepList: StepList;
  private container: HTMLElement | null = null;
  private callbacks: StepsViewCallbacks;
  /** Step ids declared `type: script` in the active run's definition. */
  private gateStepIds = new Set<string>();

  constructor(callbacks: StepsViewCallbacks = {}) {
    this.callbacks = callbacks;
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

  /** Record which steps are gates (called when a workflow definition loads). */
  setGateSteps(ids: Iterable<string>): void {
    this.gateStepIds = new Set(ids);
  }

  setStepStatus(steps: StepStatusRecord[]): void {
    const rows: StepRowData[] = steps.map((s, idx) => ({
      stepId: s.stepId,
      agent: s.agent ?? undefined,
      status: s.status,
      duration: s.duration,
      signals: s.signals ?? [],
      isGate: this.gateStepIds.has(s.stepId),
      order: idx,
    }));
    this.stepList.setSteps(rows);
  }

  /** Programmatically select a step — highlights the row and fires onSelect. */
  selectStep(stepId: string): void {
    this.stepList.selectStep(stepId);
  }

  private onStepSelect(stepId: string): void {
    api.switchStep(stepId).catch(() => {});
    this.callbacks.onStepSelect?.(stepId);
  }
}