// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderStepTree } from "../../../delivery/gui/ui-renderers.js";

function makeRun(status: string, step: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: "r1",
    workflowId: "wf",
    workflowName: "WF",
    task: "t",
    adapterId: "a",
    status,
    steps: [step],
    currentStepId: "s1",
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
  };
}

describe("renderStepTree", () => {
  it("renders a quota banner instead of a generic error when step.quota is present", () => {
    const container = document.createElement("div");
    renderStepTree(makeRun("failed", {
      stepId: "s1",
      agent: "codegen",
      task: null,
      signals: [],
      status: "failed",
      startedAt: 0,
      completedAt: 1000,
      duration: 1,
      error: "[quota] You exceeded your current quota",
      quota: { kind: "quota", resetAtMs: 1755600000000, message: "You exceeded your current quota" },
    }) as any, container);

    const banner = container.querySelector(".quota-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("[quota] You exceeded your current quota");
    expect(banner?.textContent).toContain("paused until");
    expect(container.querySelector(".event-entry")).toBeNull();
  });

  it("renders the quota banner with no reset window as just paused", () => {
    const container = document.createElement("div");
    renderStepTree(makeRun("failed", {
      stepId: "s1",
      agent: null,
      task: null,
      signals: [],
      status: "failed",
      startedAt: 0,
      completedAt: 1000,
      duration: 1,
      error: "[quota] quota exceeded",
      quota: { kind: "quota", message: "quota exceeded" },
    }) as any, container);

    expect(container.querySelector(".quota-banner")?.textContent).toContain("— paused");
  });

  it("falls back to the generic error entry when no quota is present", () => {
    const container = document.createElement("div");
    renderStepTree(makeRun("failed", {
      stepId: "s1",
      agent: null,
      task: null,
      signals: [],
      status: "failed",
      startedAt: 0,
      completedAt: 1000,
      duration: 1,
      error: "build failed",
      quota: null,
    }) as any, container);

    expect(container.querySelector(".quota-banner")).toBeNull();
    expect(container.querySelector(".event-entry")?.textContent).toBe("build failed");
  });
});