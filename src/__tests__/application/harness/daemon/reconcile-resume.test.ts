import { describe, it, expect, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { RunHost } from "../../../../application/harness/run-host.js";
import type { AdapterDef } from "../../../../application/agents/adapter.js";
import { Tracker } from "../../../../application/harness/persistence/Tracker.js";
import { Checkpointer } from "../../../../application/harness/persistence/Checkpointer.js";
import { WorkflowRegistry } from "../../../../application/planner/registry.js";
import { reconcileStaleRuns, startRun } from "../../../../application/harness/start-run.js";
import { restoreSession } from "../../../../application/harness/orchestrator/resume.js";
import type { RunTracker } from "../../../../application/harness/orchestrator/types.js";

const ADAPTER: AdapterDef = { id: "test", command: "echo", label: "Test" };

function tmpDir(base: string): string {
  const d = path.join(os.tmpdir(), `orc-${base}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Single script gate workflow; `runExpr` is the script step's `run` value. */
function scriptWorkflow(id: string, runExpr: string): object {
  return {
    version: 1,
    workflow: {
      id,
      name: id,
      description: "E3 test workflow",
      steps: [
        {
          id: "gate",
          type: "script",
          run: runExpr,
          emits: [
            { name: "pass", description: "ok" },
            { name: "fail", description: "bad" },
          ],
          on: ["__start__"],
        },
      ],
      completion: "done",
    },
  };
}

describe("E3 lifecycle verify-only", () => {
  describe("reconcileStaleRuns", () => {
    let tracker: Tracker;
    let host: RunHost;

    beforeEach(() => {
      const projectDir = tmpDir("cwd");
      const workflowsDir = path.join(projectDir, "workflows");
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, "smoke.json"), JSON.stringify(scriptWorkflow("smoke", 'exec "echo hi"')));
      tracker = new Tracker(path.join(tmpDir("db"), "runs.sqlite"));
      const registry = new WorkflowRegistry({ userDir: workflowsDir, builtinDir: tmpDir("builtin") });
      registry.loadAll();
      host = new RunHost(ADAPTER, { projectDir, tracker, registry });
    });

    it("flips a running run orphaned at restart to failed (not in bgRuns)", () => {
      tracker.createRun("orphan-1", "smoke", "smoke", "t", "test", [{ stepId: "gate", agent: null, task: null, signals: ["__start__"] }]);
      expect(tracker.getRun("orphan-1")!.status).toBe("running");

      reconcileStaleRuns(host);

      expect(tracker.getRun("orphan-1")!.status).toBe("failed");
      expect(tracker.getRun("orphan-1")!.completedAt).not.toBeNull();
    });

    it("leaves a run with an active background job untouched", () => {
      tracker.createRun("active-1", "smoke", "smoke", "t", "w", [{ stepId: "gate", agent: null, task: null, signals: ["__start__"] }]);
      host.bgRuns.set("active-1", Promise.resolve({} as any));

      reconcileStaleRuns(host);

      expect(tracker.getRun("active-1")!.status).toBe("running");
    });

    it("is idempotent for an already-failed run", () => {
      tracker.createRun("dead-1", "smoke", "smoke", "t", "w", [{ stepId: "gate", agent: null, task: null, signals: ["__start__"] }]);
      tracker.updateRunStatus("dead-1", "failed");

      reconcileStaleRuns(host);

      expect(tracker.getRun("dead-1")!.status).toBe("failed");
    });
  });

  describe("restoreSession (resume:true)", () => {
    it("reuses the existing sessionId and restores only non-failed steps", () => {
      const dir = tmpDir("cp");
      const cp = new Checkpointer(path.join(dir, "checkpoints.sqlite"));
      cp.save("demo", {
        workflowId: "smoke",
        sessionId: "seed-session",
        agentId: "test",
        stepResults: {
          gate: { status: "completed", retries: 1 },
          other: { status: "failed", error: "boom", retries: 0 },
        },
        context: { task: "demo" },
      });

      const tracker = new Tracker(path.join(dir, "runs.sqlite"));
      tracker.createRun("resume-run", "smoke", "smoke", "demo", "test", [
        { stepId: "gate", agent: null, task: null, signals: [] },
        { stepId: "other", agent: null, task: null, signals: [] },
      ]);
      const runTracker: RunTracker = { runId: "resume-run", tracker };
      const events: { type: string; stepId?: string }[] = [];
      const res = restoreSession("demo", true, cp, runTracker, e => events.push(e as any));

      expect(res.sessionId).toBe("seed-session");
      expect([...res.restoredStepResults.keys()].sort()).toEqual(["gate"]);
      expect(tracker.getRun("resume-run")!.steps.find(s => s.stepId === "gate")!.status).toBe("completed");
      expect(tracker.getRun("resume-run")!.steps.find(s => s.stepId === "other")!.status).toBe("pending");
      expect(events.some(e => e.type === "step_complete" && e.stepId === "gate")).toBe(true);
      cp.close();
      tracker.close();
    });

    it("starts fresh when resume:true but no checkpoint exists", () => {
      const dir = tmpDir("cp2");
      const cp = new Checkpointer(path.join(dir, "checkpoints.sqlite"));
      const res = restoreSession("nope", true, cp);
      expect(res.sessionId.length).toBe(36); // a new UUID
      expect(res.restoredStepResults.size).toBe(0);
      cp.close();
    });
  });

  describe("startRun with resume:true through the full harness", () => {
    it("completes a script workflow started with resume:true", async () => {
      const projectDir = tmpDir("full");
      const workflowsDir = path.join(projectDir, "workflows");
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, "smoke.json"), JSON.stringify(scriptWorkflow("smoke", 'exec "echo resumed"')));
      const tracker = new Tracker(path.join(projectDir, ".orc", "runs.sqlite"));
      const registry = new WorkflowRegistry({ userDir: workflowsDir, builtinDir: tmpDir("builtin") });
      registry.loadAll();
      const host = new RunHost(ADAPTER, { projectDir, tracker, registry });

      const { runId } = await startRun(host, "resume-task", "smoke", true, { runId: "resume-full-1" });
      await host.bgRuns.get(runId);

      const run = tracker.getRun(runId);
      expect(run!.status).toBe("completed");
      expect(run!.steps.find(s => s.stepId === "gate")!.status).toBe("completed");
      tracker.close();
    });
  });
});