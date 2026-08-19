import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { AdapterDef } from "../../../../application/agents/adapter.js";

vi.mock("../../../../application/harness/start-run.js", () => ({
  startRun: vi.fn(async () => ({
    runId: "x",
    workflowId: "wf",
    workflowName: "WF",
    status: "running",
    message: "",
  })),
  reconcileStaleRuns: vi.fn(),
}));

import { RunHost } from "../../../../application/harness/run-host.js";
import { Tracker } from "../../../../application/harness/persistence/Tracker.js";
import { WorkflowRegistry } from "../../../../application/planner/registry.js";
import { startRun } from "../../../../application/harness/start-run.js";

const mockedStartRun = vi.mocked(startRun);

const ADAPTER: AdapterDef = { id: "test", command: "echo", label: "Test" };

function tmpDir(base: string): string {
  const d = path.join(os.tmpdir(), `orc-${base}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeHost(opts?: { quotaResumeDelayMs?: number }): { host: RunHost; tracker: Tracker } {
  const projectDir = tmpDir("wake");
  const workflowsDir = path.join(projectDir, "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  const tracker = new Tracker(path.join(projectDir, ".orc", "runs.sqlite"));
  const registry = new WorkflowRegistry({ userDir: workflowsDir, builtinDir: tmpDir("builtin") });
  registry.loadAll();
  const host = new RunHost(ADAPTER, {
    projectDir,
    tracker,
    registry,
    quotaResumeDelayMs: opts?.quotaResumeDelayMs,
  });
  return { host, tracker };
}

describe("RunHost paused-run wake timer (ADR-022)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedStartRun.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules an auto-resume at resetAtMs and fires startRun(resume) once", () => {
    const { host, tracker } = makeHost();
    const resetAtMs = Date.now() + 60_000;
    tracker.createRun("w1", "wf", "WF", "t", "test", [{ stepId: "s1", agent: null, task: null, signals: [] }]);
    tracker.pauseRun("w1", resetAtMs);

    const scheduled = host.schedulePausedRunResume("w1", "task", "wf", resetAtMs);
    expect(scheduled).toBe(true);

    vi.advanceTimersByTime(59_999);
    expect(mockedStartRun).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mockedStartRun).toHaveBeenCalledTimes(1);
    expect(mockedStartRun).toHaveBeenCalledWith(host, "task", "wf", true, { runId: "w1" });
    tracker.close();
  });

  it("resumes immediately when the reset window already passed", () => {
    const { host, tracker } = makeHost();
    const resetAtMs = Date.now() - 1_000;
    tracker.createRun("w2", "wf", "WF", "t", "test", [{ stepId: "s1", agent: null, task: null, signals: [] }]);
    tracker.pauseRun("w2", resetAtMs);

    const scheduled = host.schedulePausedRunResume("w2", "task", "wf", resetAtMs);
    expect(scheduled).toBe(true);

    vi.advanceTimersByTime(0);
    expect(mockedStartRun).toHaveBeenCalledTimes(1);
    expect(mockedStartRun).toHaveBeenCalledWith(host, "task", "wf", true, { runId: "w2" });
    tracker.close();
  });

  it("uses the configured delay when no reset window was reported", () => {
    const { host, tracker } = makeHost({ quotaResumeDelayMs: 5_000 });
    tracker.createRun("w3", "wf", "WF", "t", "test", [{ stepId: "s1", agent: null, task: null, signals: [] }]);
    tracker.pauseRun("w3");

    const scheduled = host.schedulePausedRunResume("w3", "task", "wf");
    expect(scheduled).toBe(true);

    vi.advanceTimersByTime(4_999);
    expect(mockedStartRun).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mockedStartRun).toHaveBeenCalledTimes(1);
    expect(mockedStartRun).toHaveBeenCalledWith(host, "task", "wf", true, { runId: "w3" });
    tracker.close();
  });

  it("does NOT schedule when no reset window and no delay is available (manual resume only)", () => {
    const { host, tracker } = makeHost({ quotaResumeDelayMs: 0 });
    tracker.createRun("w4", "wf", "WF", "t", "test", [{ stepId: "s1", agent: null, task: null, signals: [] }]);
    tracker.pauseRun("w4");

    const scheduled = host.schedulePausedRunResume("w4", "task", "wf");
    expect(scheduled).toBe(false);

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(mockedStartRun).not.toHaveBeenCalled();
    expect(tracker.getRun("w4")!.status).toBe("paused");
    tracker.close();
  });

  it("clearPausedRunResume disarms a scheduled wake (manual-resume path)", () => {
    const { host, tracker } = makeHost({ quotaResumeDelayMs: 60_000 });
    tracker.createRun("w5", "wf", "WF", "t", "test", [{ stepId: "s1", agent: null, task: null, signals: [] }]);
    tracker.pauseRun("w5");

    expect(host.schedulePausedRunResume("w5", "task", "wf")).toBe(true);

    // A manual resume of this paused run disarms its stale wake so it can
    // never fire a duplicate orchestrate() on the same runId later.
    host.clearPausedRunResume("w5");

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(mockedStartRun).not.toHaveBeenCalled();
    expect(tracker.getRun("w5")!.status).toBe("paused");
    tracker.close();
  });

  it("forwards signal and onEvent to the wake-resumed startRun", () => {
    const { host, tracker } = makeHost({ quotaResumeDelayMs: 5_000 });
    const onEvent = vi.fn();
    const controller = new AbortController();
    tracker.createRun("w6", "wf", "WF", "t", "test", [{ stepId: "s1", agent: null, task: null, signals: [] }]);
    tracker.pauseRun("w6");

    expect(host.schedulePausedRunResume("w6", "task", "wf", undefined, { signal: controller.signal, onEvent })).toBe(true);

    vi.advanceTimersByTime(5_000);
    expect(mockedStartRun).toHaveBeenCalledTimes(1);
    expect(mockedStartRun).toHaveBeenCalledWith(host, "task", "wf", true, {
      runId: "w6",
      signal: controller.signal,
      onEvent,
    });
    tracker.close();
  });

  it("skips the wake resume when the signal was already aborted", () => {
    const { host, tracker } = makeHost({ quotaResumeDelayMs: 5_000 });
    const controller = new AbortController();
    controller.abort();
    tracker.createRun("w7", "wf", "WF", "t", "test", [{ stepId: "s1", agent: null, task: null, signals: [] }]);
    tracker.pauseRun("w7");

    expect(host.schedulePausedRunResume("w7", "task", "wf", undefined, { signal: controller.signal })).toBe(true);

    vi.advanceTimersByTime(5_000);
    expect(mockedStartRun).not.toHaveBeenCalled();
    expect(tracker.getRun("w7")!.status).toBe("paused");
    tracker.close();
  });
});