import type { StepOutcome } from "./step-runner.js";

const MAX_STEPS = 50;
const MAX_LOOP = 5;

export interface BudgetCheck {
  ok: boolean;
  error?: string;
}

export function checkStepBudget(completed: number): BudgetCheck {
  if (completed >= MAX_STEPS) {
    return { ok: false, error: `Step budget exceeded: ${completed} >= ${MAX_STEPS} max` };
  }
  return { ok: true };
}

interface RecentWindow {
  stepId: string;
  status: string;
}

export function detectLoop(
  recent: StepOutcome[],
  maxRepetitions: number = MAX_LOOP,
): BudgetCheck {
  if (recent.length < 2) return { ok: true };

  const last = recent[recent.length - 1];
  const count = recent.filter(r => r.stepId === last.stepId && r.status === last.status).length;

  if (count > maxRepetitions) {
    return {
      ok: false,
      error: `Loop detected: step "${last.stepId}" repeated ${count} times with status "${last.status}"`,
    };
  }

  return { ok: true };
}
