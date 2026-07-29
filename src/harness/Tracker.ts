/**
 * Tracker — Visibility layer.
 *
 * Tracks live and historical workflow executions for operator inspection via
 * the MCP API and GUI. Records step timing, status, agent assignment, and
 * errors — but not raw content.
 *
 * Keyed by a UUID generated at dispatch time (single-run identity).
 * Stored in: .orc/runs.sqlite
 */
import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";

export interface StepStatusRecord {
  stepId: string;
  agent: string | null;
  task: string | null;
  dependsOn: string[];
  status: "pending" | "running" | "completed" | "failed";
  startedAt: number | null;
  completedAt: number | null;
  duration: number | null;
  error: string | null;
}

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  runId: string;
  workflowId: string;
  workflowName: string;
  task: string;
  adapterId: string;
  status: RunStatus;
  steps: StepStatusRecord[];
  currentStepId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export class Tracker {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = dbPath || path.join(process.cwd(), ".orc", "runs.sqlite");
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolved);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
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
      )
    `);
  }

  createRun(
    runId: string,
    workflowId: string,
    workflowName: string,
    task: string,
    adapterId: string,
    steps: { stepId: string; agent: string | null; task: string | null; dependsOn: string[] }[],
  ): RunRecord {
    const now = Date.now();
    const stepStates: StepStatusRecord[] = steps.map(s => ({
      stepId: s.stepId,
      agent: s.agent,
      task: s.task,
      dependsOn: s.dependsOn,
      status: "pending" as const,
      startedAt: null,
      completedAt: null,
      duration: null,
      error: null,
    }));
    const stmt = this.db.prepare(`
      INSERT INTO runs (run_id, workflow_id, workflow_name, task, adapter_id, status, steps_json, current_step_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, ?, ?)
    `);
    stmt.run(runId, workflowId, workflowName, task, adapterId, JSON.stringify(stepStates), now, now);
    return this.getRun(runId)!;
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as any;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  listRuns(): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as any[];
    return rows.map(r => this.rowToRecord(r));
  }

  updateRunStatus(runId: string, status: RunStatus): void {
    const now = Date.now();
    const completedAt = status === "completed" || status === "failed" || status === "cancelled" ? now : null;
    this.db.prepare(`
      UPDATE runs SET status = ?, updated_at = ?, completed_at = ? WHERE run_id = ?
    `).run(status, now, completedAt, runId);
  }

  setStepRunning(runId: string, stepId: string): void {
    const now = Date.now();
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT steps_json FROM runs WHERE run_id = ?").get(runId) as any;
      if (!row) return;
      const steps: StepStatusRecord[] = JSON.parse(row.steps_json);
      const step = steps.find(s => s.stepId === stepId);
      if (!step) return;
      step.status = "running";
      step.startedAt = now;
      this.db.prepare("UPDATE runs SET steps_json = ?, current_step_id = ?, updated_at = ? WHERE run_id = ?")
        .run(JSON.stringify(steps), stepId, now, runId);
    })();
  }

  setStepCompleted(runId: string, stepId: string, status: "completed" | "failed", error?: string): void {
    const now = Date.now();
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT steps_json, status FROM runs WHERE run_id = ?").get(runId) as any;
      if (!row) return;
      const steps: StepStatusRecord[] = JSON.parse(row.steps_json);
      const step = steps.find(s => s.stepId === stepId);
      if (!step) return;
      step.status = status;
      step.completedAt = now;
      step.error = error || null;
      if (step.startedAt) {
        step.duration = now - step.startedAt;
      }
      this.db.prepare("UPDATE runs SET steps_json = ?, updated_at = ? WHERE run_id = ?")
        .run(JSON.stringify(steps), now, runId);
    })();
  }

  close(): void {
    this.db.close();
  }

  private rowToRecord(row: any): RunRecord {
    return {
      runId: row.run_id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      task: row.task,
      adapterId: row.adapter_id,
      status: row.status,
      steps: JSON.parse(row.steps_json),
      currentStepId: row.current_step_id || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || null,
    };
  }
}
