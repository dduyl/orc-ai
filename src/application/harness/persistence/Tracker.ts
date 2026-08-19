import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import type { QuotaInfo } from "../../agents/errors.js";

export interface StepStatusRecord {
  stepId: string;
  agent: string | null;
  task: string | null;
  signals: string[];
  status: "pending" | "running" | "completed" | "failed";
  startedAt: number | null;
  completedAt: number | null;
  duration: number | null;
  error: string | null;
  quota: QuotaInfo | null;
}

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "paused";

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
  /** ADR-022: epoch-ms at which the run's quota window resets (paused runs). */
  resetAtMs?: number;
  /** ADR-022: why the run is paused (e.g. `quota_exhausted`). */
  pauseReason?: string;
}

export class Tracker {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const resolved = dbPath || path.join(process.cwd(), ".orc", "runs.sqlite");
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(resolved);
    this.db.exec("PRAGMA journal_mode = WAL");
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
        completed_at INTEGER,
        reset_at_ms INTEGER,
        pause_reason TEXT
      )
    `);
    // Migration: add the ADR-022 pause columns to databases created
    // before this schema existed.
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(runs)").all() as any[]).map((c: any) => c.name),
    );
    if (!cols.has("reset_at_ms")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN reset_at_ms INTEGER");
    }
    if (!cols.has("pause_reason")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN pause_reason TEXT");
    }
  }

  createRun(
    runId: string,
    workflowId: string,
    workflowName: string,
    task: string,
    adapterId: string,
    steps: { stepId: string; agent: string | null; task: string | null; signals: string[] }[],
  ): RunRecord {
    const now = Date.now();
    const stepStates: StepStatusRecord[] = steps.map(s => ({
      stepId: s.stepId,
      agent: s.agent,
      task: s.task,
      signals: s.signals,
      status: "pending" as const,
      startedAt: null,
      completedAt: null,
      duration: null,
      error: null,
      quota: null,
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
    // Guard the resume path: a finished run (completed/failed/cancelled) must
    // never be revived as "running" — that would resurrect a dead workflow as a
    // live background job. `paused -> running` is the legitimate resume
    // transition and stays allowed.
    if (status === "running") {
      const current = this.getRun(runId);
      if (current && (current.status === "completed" || current.status === "failed" || current.status === "cancelled")) {
        throw new Error(`Illegal status transition: ${current.status} -> running`);
      }
    }
    // Leaving a paused run (resume, or any other terminal transition) clears the
    // pause metadata — it only describes the paused window itself.
    this.db.prepare(`
      UPDATE runs SET status = ?, reset_at_ms = NULL, pause_reason = NULL, updated_at = ?, completed_at = ? WHERE run_id = ?
    `).run(status, now, completedAt, runId);
  }

  /**
   * ADR-022: mark a run as paused (quota exhaustion) and record when
   * the quota window resets so the daemon can schedule an auto-resume.
   */
  pauseRun(runId: string, resetAtMs?: number, pauseReason = "quota_exhausted"): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE runs SET status = 'paused', reset_at_ms = ?, pause_reason = ?, updated_at = ?, completed_at = NULL WHERE run_id = ?
    `).run(resetAtMs ?? null, pauseReason, now, runId);
  }

  setStepRunning(runId: string, stepId: string): void {
    this.mutateStep(runId, stepId, (step, now) => {
      step.status = "running";
      step.startedAt = now;
    }, (steps, now) => {
      this.db.prepare("UPDATE runs SET steps_json = ?, current_step_id = ?, updated_at = ? WHERE run_id = ?")
        .run(JSON.stringify(steps), stepId, now, runId);
    });
  }

  setStepCompleted(runId: string, stepId: string, status: "completed" | "failed", error?: string, quota?: QuotaInfo): void {
    this.mutateStep(runId, stepId, (step, now) => {
      step.status = status;
      step.completedAt = now;
      step.error = error || null;
      step.quota = quota ?? null;
      if (step.startedAt) {
        step.duration = now - step.startedAt;
      }
    });
  }

  private mutateStep(
    runId: string,
    stepId: string,
    mutate: (step: StepStatusRecord, now: number) => void,
    finalize?: (steps: StepStatusRecord[], now: number) => void,
  ): void {
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      const row = this.db.prepare("SELECT steps_json FROM runs WHERE run_id = ?").get(runId) as any;
      if (row) {
        const steps: StepStatusRecord[] = JSON.parse(row.steps_json);
        const step = steps.find(s => s.stepId === stepId);
        if (step) {
          mutate(step, now);
          if (finalize) {
            finalize(steps, now);
          } else {
            this.db.prepare("UPDATE runs SET steps_json = ?, updated_at = ? WHERE run_id = ?")
              .run(JSON.stringify(steps), now, runId);
          }
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
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
      resetAtMs: row.reset_at_ms ?? undefined,
      pauseReason: row.pause_reason ?? undefined,
    };
  }
}
