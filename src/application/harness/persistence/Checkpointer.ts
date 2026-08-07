import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import type { HookEvent } from "../../../core/hooks.js";

export interface StepResumeSnapshot {
  status: "completed" | "failed";
  output?: string;
  error?: string;
  retries: number;
  hooks?: HookEvent[];
}

export interface ResumeState {
  taskId: string;
  workflowId: string;
  sessionId: string;
  agentId: string;
  /** Run that owns this checkpoint snapshot ("" = pre-ownership / legacy). */
  runId?: string;
  stepResults: Record<string, StepResumeSnapshot>;
  context: Record<string, unknown>;
}

export class Checkpointer {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        task_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL DEFAULT '',
        step_results TEXT NOT NULL DEFAULT '{}',
        context TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Migrate existing checkpoint DBs (pre-run_id schema). `CREATE TABLE IF NOT
    // EXISTS` does not add columns to an already-present table, so add the
    // ownership column when the old schema is detected.
    const columns = this.db.prepare("PRAGMA table_info(checkpoints)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "run_id")) {
      this.db.exec("ALTER TABLE checkpoints ADD COLUMN run_id TEXT NOT NULL DEFAULT ''");
    }
  }

  /**
   * Persist (or stamp) the owning run's checkpoint. `runId` records which run
   * produced the snapshot; `prune()` uses it to avoid deleting a concurrent
   * same-task run's live row. Optional for callers that predate run ownership
   * (stamped as the empty owner, cleaned up by an owner-less `prune`).
   */
  save(taskKey: string, state: Omit<ResumeState, "taskId">, runId?: string): void {
    const owner = runId ?? "";
    const stmt = this.db.prepare(`
      INSERT INTO checkpoints (task_id, workflow_id, session_id, agent_id, run_id, step_results, context, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(task_id) DO UPDATE SET
        workflow_id = excluded.workflow_id,
        session_id = excluded.session_id,
        agent_id = excluded.agent_id,
        run_id = excluded.run_id,
        step_results = excluded.step_results,
        context = excluded.context,
        updated_at = datetime('now')
    `);
    stmt.run(
      taskKey,
      state.workflowId,
      state.sessionId,
      state.agentId,
      owner,
      JSON.stringify(state.stepResults),
      JSON.stringify(state.context),
    );
  }

  load(taskKey: string): ResumeState | null {
    const row = this.db.prepare("SELECT * FROM checkpoints WHERE task_id = ?").get(taskKey) as any;
    if (!row) return null;
    return {
      taskId: row.task_id,
      workflowId: row.workflow_id,
      sessionId: row.session_id,
      agentId: row.agent_id || "",
      runId: row.run_id || "",
      stepResults: JSON.parse(row.step_results),
      context: JSON.parse(row.context),
    };
  }

  /**
   * Delete a task's checkpoint. When `runId` is given, only a row owned by that
   * run is deleted — a run can never remove a checkpoint that a concurrent
   * same-task run wrote. With no owner (legacy callers), clears the task row
   * regardless of ownership to preserve pre-ownership semantics.
   */
  prune(taskKey: string, runId?: string): void {
    if (runId) {
      this.db.prepare("DELETE FROM checkpoints WHERE task_id = ? AND run_id = ?").run(taskKey, runId);
    } else {
      this.db.prepare("DELETE FROM checkpoints WHERE task_id = ?").run(taskKey);
    }
  }

  close(): void {
    this.db.close();
  }
}
