import { describe, it, expect } from "vitest";
import { Checkpointer, type ResumeState } from "../../../../application/harness/persistence/Checkpointer.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";

describe("Checkpointer", () => {
  const state = (sessionId: string): Omit<ResumeState, "taskId"> => ({
    workflowId: "wf-1",
    sessionId,
    agentId: "opencode",
    stepResults: {
      step1: { status: "completed" as const, output: "done", retries: 0 },
    },
    context: { key: "val" },
  });

  const tmpDb = (): string => {
    const tmpDir = path.join(os.tmpdir(), `orc-cp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return path.join(tmpDir, "checkpoints.sqlite");
  };

  it("saves and loads checkpoint state", () => {
    const cp = new Checkpointer(tmpDb());

    cp.save("test-task-1", state("sess-1"));

    const loaded = cp.load("test-task-1");
    expect(loaded).not.toBeNull();
    expect(loaded?.workflowId).toBe("wf-1");
    expect(loaded?.sessionId).toBe("sess-1");
    expect(loaded?.stepResults.step1.status).toBe("completed");

    cp.prune("test-task-1");
    expect(cp.load("test-task-1")).toBeNull();

    cp.close();
  });

  it("stamps the owning runId on save and returns it on load", () => {
    const cp = new Checkpointer(tmpDb());
    cp.save("task", state("sess-1"), "run-A");
    expect(cp.load("task")?.runId).toBe("run-A");
    cp.close();
  });

  it("legacy owner-less prune still clears the task row", () => {
    const cp = new Checkpointer(tmpDb());
    cp.save("task", state("sess-1"), "run-A");
    cp.prune("task");
    expect(cp.load("task")).toBeNull();
    cp.close();
  });

  it("owner-scoped prune does NOT delete another run's checkpoint", () => {
    const cp = new Checkpointer(tmpDb());
    // Run A saves, then is superseded by a concurrent same-task run B.
    cp.save("task", state("sess-A"), "run-A");
    cp.save("task", state("sess-B"), "run-B");
    // A finishes successfully and tries to prune its row.
    cp.prune("task", "run-A");
    // B's live checkpoint must survive.
    const loaded = cp.load("task");
    expect(loaded).not.toBeNull();
    expect(loaded?.runId).toBe("run-B");
    cp.close();
  });

  it("owner-scoped prune deletes the owning run's own row", () => {
    const cp = new Checkpointer(tmpDb());
    cp.save("task", state("sess-A"), "run-A");
    cp.prune("task", "run-A");
    expect(cp.load("task")).toBeNull();
    cp.close();
  });

  it("migrates a pre-run_id checkpoint DB without data loss", () => {
    // Create an old-schema DB (no run_id column) with a row.
    const dbPath = tmpDb();
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE checkpoints (
        task_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        step_results TEXT NOT NULL DEFAULT '{}',
        context TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    db.prepare(
      "INSERT INTO checkpoints (task_id, workflow_id, session_id, agent_id, step_results, context) VALUES (?,?,?,?,?,?)",
    ).run("legacy", "wf-1", "sess-1", "opencode", "{}", "{}");
    db.close();

    // Reopen through the new Checkpointer: migration adds run_id, row survives.
    const cp = new Checkpointer(dbPath);
    const loaded = cp.load("legacy");
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe("sess-1");
    expect(loaded?.runId).toBe("");
    // Owner-less save on the migrated DB writes fine.
    cp.save("legacy", state("sess-2"));
    expect(cp.load("legacy")?.sessionId).toBe("sess-2");
    cp.close();
  });
});
