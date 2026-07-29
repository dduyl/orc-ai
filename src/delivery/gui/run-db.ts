import { resolve } from "node:path";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

let _projectDir: string | undefined;

export function setProjectDir(dir: string): void {
  _projectDir = dir;
}

function projectDir(): string {
  return _projectDir ?? process.cwd();
}

export function getRunDb(): Database.Database | null {
  const dbPath = resolve(projectDir(), ".orc", "runs.sqlite");
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

export function queryRunStatus(runId: string): any | null {
  const db = getRunDb();
  if (!db) return null;
  try {
    const run = db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as any;
    if (!run) return null;
    const steps = db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY rowid").all(runId);
    return {
      runId: run.run_id,
      workflowId: run.workflow_id,
      workflowName: run.workflow_name,
      task: run.task,
      adapterId: run.adapter_id,
      status: run.status,
      currentStepId: run.current_step_id,
      steps,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      completedAt: run.completed_at,
    };
  } finally {
    db.close();
  }
}

export function listRunSummaries(): any[] {
  const db = getRunDb();
  if (!db) return [];
  try {
    return db.prepare("SELECT run_id, workflow_id, workflow_name, status, created_at, updated_at, completed_at FROM runs ORDER BY created_at DESC LIMIT 50").all();
  } finally {
    db.close();
  }
}
