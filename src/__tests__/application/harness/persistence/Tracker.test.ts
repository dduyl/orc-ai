import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Tracker } from "../../../../application/harness/persistence/Tracker.js";

function tmpDb(): { dir: string; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-tracker-"));
  return { dir, path: path.join(dir, "runs.sqlite") };
}

describe("Tracker quota persistence", () => {
  it("setStepCompleted persists a [quota]-prefixed error plus the structured quota payload", () => {
    const { dir, path: db } = tmpDb();
    try {
      const t = new Tracker(db);
      t.createRun("r1", "wf", "WF", "t", "a", [{ stepId: "s1", agent: "a", task: null, signals: [] }]);
      t.setStepRunning("r1", "s1");
      const quota = { kind: "quota" as const, resetAtMs: 1755600000000, message: "You exceeded your current quota" };
      t.setStepCompleted("r1", "s1", "failed", `[quota] You exceeded your current quota`, quota);

      const got = t.getRun("r1")!;
      expect(got.steps[0].status).toBe("failed");
      expect(got.steps[0].error).toBe("[quota] You exceeded your current quota");
      expect(got.steps[0].quota).toEqual(quota);
      t.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("new runs start with quota null and plain completions keep it null", () => {
    const { dir, path: db } = tmpDb();
    try {
      const t = new Tracker(db);
      t.createRun("r2", "wf", "WF", "t", "a", [{ stepId: "s1", agent: "a", task: null, signals: [] }]);
      expect(t.getRun("r2")!.steps[0].quota).toBeNull();

      t.setStepCompleted("r2", "s1", "failed", "boom");
      expect(t.getRun("r2")!.steps[0].quota).toBeNull();
      t.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Tracker run status", () => {
  it("accepts 'paused' and persists it without a completedAt", () => {
    const { dir, path: db } = tmpDb();
    try {
      const t = new Tracker(db);
      t.createRun("r3", "wf", "WF", "t", "a", [{ stepId: "s1", agent: "a", task: null, signals: [] }]);
      t.updateRunStatus("r3", "paused");

      const got = t.getRun("r3")!;
      expect(got.status).toBe("paused");
      expect(got.completedAt).toBeNull();
      t.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pauseRun persists reset_at_ms + pause_reason and reads them back", () => {
    const { dir, path: db } = tmpDb();
    try {
      const t = new Tracker(db);
      t.createRun("r4", "wf", "WF", "t", "a", [{ stepId: "s1", agent: "a", task: null, signals: [] }]);
      t.pauseRun("r4", 1755600000000, "quota_exhausted");

      const got = t.getRun("r4")!;
      expect(got.status).toBe("paused");
      expect(got.resetAtMs).toBe(1755600000000);
      expect(got.pauseReason).toBe("quota_exhausted");
      expect(got.completedAt).toBeNull();
      t.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pauseRun defaults the reason and leaves resetAtMs unset when absent", () => {
    const { dir, path: db } = tmpDb();
    try {
      const t = new Tracker(db);
      t.createRun("r5", "wf", "WF", "t", "a", [{ stepId: "s1", agent: "a", task: null, signals: [] }]);
      t.pauseRun("r5");

      const got = t.getRun("r5")!;
      expect(got.status).toBe("paused");
      expect(got.pauseReason).toBe("quota_exhausted");
      expect(got.resetAtMs).toBeUndefined();
      t.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updateRunStatus('running') clears the pause metadata (resume transition)", () => {
    const { dir, path: db } = tmpDb();
    try {
      const t = new Tracker(db);
      t.createRun("r6", "wf", "WF", "t", "a", [{ stepId: "s1", agent: "a", task: null, signals: [] }]);
      t.pauseRun("r6", 1755600000000);
      t.updateRunStatus("r6", "running");

      const got = t.getRun("r6")!;
      expect(got.status).toBe("running");
      expect(got.resetAtMs).toBeUndefined();
      expect(got.pauseReason).toBeUndefined();
      expect(got.completedAt).toBeNull();
      t.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a pre-pause-schema DB (no reset_at_ms/pause_reason) and accepts pauseRun", () => {
    const { dir, path: db } = tmpDb();
    try {
      const old = new DatabaseSync(db);
      old.exec(`CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          workflow_name TEXT NOT NULL DEFAULT '',
          task TEXT NOT NULL DEFAULT '',
          adapter_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          steps_json TEXT NOT NULL DEFAULT '[]',
          current_step_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        )`);
      old.prepare(
        "INSERT INTO runs (run_id, workflow_id, workflow_name, task, adapter_id, status, steps_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run("legacy", "wf", "WF", "t", "a", "completed", "[]", 1, 1);
      old.close();

      const t = new Tracker(db);
      expect(t.getRun("legacy")!.status).toBe("completed");
      t.pauseRun("legacy", 42);
      expect(t.getRun("legacy")!.status).toBe("paused");
      expect(t.getRun("legacy")!.resetAtMs).toBe(42);
      t.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects reviving a completed run as running (illegal transition)", () => {
    const { dir, path: db } = tmpDb();
    try {
      const t = new Tracker(db);
      t.createRun("r7", "wf", "WF", "t", "a", [{ stepId: "s1", agent: "a", task: null, signals: [] }]);
      t.updateRunStatus("r7", "completed");
      expect(() => t.updateRunStatus("r7", "running")).toThrow(/Illegal status transition: completed -> running/);
      expect(t.getRun("r7")!.status).toBe("completed");
      t.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects reviving a failed run as running", () => {
    const { dir, path: db } = tmpDb();
    try {
      const t = new Tracker(db);
      t.createRun("r8", "wf", "WF", "t", "a", [{ stepId: "s1", agent: "a", task: null, signals: [] }]);
      t.updateRunStatus("r8", "failed");
      expect(() => t.updateRunStatus("r8", "running")).toThrow(/Illegal status transition: failed -> running/);
      expect(t.getRun("r8")!.status).toBe("failed");
      t.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});