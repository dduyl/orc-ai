import { describe, it, expect, afterEach, vi } from "vitest";
import { StreamEmitter, setStreamEventHandler } from "../../../adapters/stream/emitter.js";
import { bindStreamEvents } from "../../../delivery/tui/stream-handler.js";

function fakePanels(): {
  tree: Record<string, any>;
  output: Record<string, any>;
  status: Record<string, any>;
  screen: Record<string, any>;
} {
  return {
    tree: {
      addNode: vi.fn(),
      updateStatus: vi.fn(),
      updateOutput: vi.fn(),
      getSelectedId: () => null,
      isRootSelected: () => true,
    },
    output: { showHistory: vi.fn() },
    status: { updateSteps: vi.fn(), updateStatus: vi.fn() },
    screen: { render: vi.fn() },
  };
}

afterEach(() => {
  setStreamEventHandler(null);
});

describe("bindStreamEvents step_finish", () => {
  it("reason 'quota' marks the step failed and prints the pause line", () => {
    const { tree, output, status, screen } = fakePanels();
    const counters = { stepActiveCount: 0, stepTotalCount: 0 };
    bindStreamEvents(tree as any, output as any, status as any, screen as any, counters);

    const em = new StreamEmitter("ses-quota");
    em.stepStart("snap", "code");
    em.stepFinish("step", "quota", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0, {
      kind: "quota",
      message: "You exceeded your current quota",
    });

    expect(counters.stepActiveCount).toBe(0);
    expect(tree.updateStatus.mock.calls.at(-1)[1]).toBe("failed");
    expect(status.updateStatus.mock.calls.at(-1)[0]).toBe("Quota exhausted — paused");
  });

  it("reason 'quota' with resetAtMs announces the retry window", () => {
    const { tree, output, status, screen } = fakePanels();
    const counters = { stepActiveCount: 0, stepTotalCount: 0 };
    bindStreamEvents(tree as any, output as any, status as any, screen as any, counters);

    const em = new StreamEmitter("ses-reset");
    em.stepStart("snap", "code");
    em.stepFinish("step", "quota", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0, {
      kind: "quota",
      resetAtMs: 1755600000000,
      message: "quota exceeded",
    });

    expect(status.updateStatus.mock.calls.at(-1)[0]).toBe("Quota exhausted — will retry after " + new Date(1755600000000).toLocaleString());
  });

  it("a plain stop keeps the normal completed status line", () => {
    const { tree, output, status, screen } = fakePanels();
    const counters = { stepActiveCount: 0, stepTotalCount: 0 };
    bindStreamEvents(tree as any, output as any, status as any, screen as any, counters);

    const em = new StreamEmitter("ses-stop");
    em.stepStart("snap", "code");
    em.stepFinish("step", "stop", "", { total: 1, input: 1, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);

    expect(tree.updateStatus.mock.calls.at(-1)[1]).toBe("completed");
    expect(status.updateStatus.mock.calls.at(-1)[0]).toBe("Step completed");
  });
});