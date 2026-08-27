// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StepList, type StepRowData } from "../../../delivery/gui/step-list.js";

describe("StepList", () => {
  let container: HTMLDivElement;
  let onSelect: ReturnType<typeof vi.fn>;
  let stepList: StepList;

  const steps: StepRowData[] = [
    { stepId: "s1", status: "completed", isGate: false, order: 0 },
    { stepId: "s2", status: "running", isGate: false, order: 1 },
  ];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onSelect = vi.fn();
    stepList = new StepList({ onSelect });
  });

  afterEach(() => {
    stepList.unmount();
    container.remove();
  });

  it("selectStep highlights the row and fires onSelect", () => {
    stepList.mount(container);
    stepList.setSteps(steps);

    stepList.selectStep("s1");

    const row = container.querySelector<HTMLElement>('tr[data-step-id="s1"]');
    expect(row).not.toBeNull();
    expect(row!.classList.contains("step-selected")).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("selectStep clears previous selection", () => {
    stepList.mount(container);
    stepList.setSteps(steps);

    stepList.selectStep("s1");
    stepList.selectStep("s2");

    const row1 = container.querySelector<HTMLElement>('tr[data-step-id="s1"]');
    const row2 = container.querySelector<HTMLElement>('tr[data-step-id="s2"]');
    expect(row1!.classList.contains("step-selected")).toBe(false);
    expect(row2!.classList.contains("step-selected")).toBe(true);
  });

  it("selectStep is a no-op when not mounted", () => {
    // Do NOT call mount()
    stepList.selectStep("s1");

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking a row fires onSelect", () => {
    stepList.mount(container);
    stepList.setSteps(steps);

    const row = container.querySelector<HTMLElement>('tr[data-step-id="s1"]');
    expect(row).not.toBeNull();
    row!.click();

    expect(onSelect).toHaveBeenCalledWith("s1");
  });
});
