import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
});