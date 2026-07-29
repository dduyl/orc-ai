/**
 * Checkpointer — Durability layer.
 *
 * Saves and restores step-level execution snapshots so that a workflow can
 * resume from the last completed step after a process crash or restart.
 *
 * Keyed by the task description string (cross-run identity).
 * Stored in: .orc/checkpoints.sqlite
 */
import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import type { HookEvent } from "../hooks/types.js";

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
  stepResults: Record<string, StepResumeSnapshot>;
  context: Record<string, unknown>;
}

export class Checkpointer {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        task_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        step_results TEXT NOT NULL DEFAULT '{}',
        context TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  save(taskKey: string, state: Omit<ResumeState, "taskId">): void {
    const stmt = this.db.prepare(`
      INSERT INTO checkpoints (task_id, workflow_id, session_id, agent_id, step_results, context, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(task_id) DO UPDATE SET
        workflow_id = excluded.workflow_id,
        session_id = excluded.session_id,
        agent_id = excluded.agent_id,
        step_results = excluded.step_results,
        context = excluded.context,
        updated_at = datetime('now')
    `);
    stmt.run(
      taskKey,
      state.workflowId,
      state.sessionId,
      state.agentId,
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
      stepResults: JSON.parse(row.step_results),
      context: JSON.parse(row.context),
    };
  }

  prune(taskKey: string): void {
    this.db.prepare("DELETE FROM checkpoints WHERE task_id = ?").run(taskKey);
  }

  close(): void {
    this.db.close();
  }
}
