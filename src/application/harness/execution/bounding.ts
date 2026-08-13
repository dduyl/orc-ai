import type { StepOutcome } from "./step-runner.js";

const MAX_STEPS = 50;
const MAX_LOOP = 5;
export const MAX_RESEARCH_TOOL_CALLS = 5;
export const RESEARCH_ROLES = new Set(["spec", "arch"]);

export interface BudgetCheck {
  ok: boolean;
  error?: string;
}

export function isResearchRole(role: string): boolean {
  return RESEARCH_ROLES.has(role.toLowerCase());
}

export function checkResearchBudget(role: string, researchCalls: number): BudgetCheck {
  if (!isResearchRole(role)) {
    if (researchCalls > 0) {
      return {
        ok: false,
        error: `Role '${role}' is not permitted open-ended research tool calls (ADR-008). Document assumptions instead.`,
      };
    }
    return { ok: true };
  }
  if (researchCalls >= MAX_RESEARCH_TOOL_CALLS) {
    return {
      ok: false,
      error: `Research tool-call budget exceeded for role '${role}': ${researchCalls} >= ${MAX_RESEARCH_TOOL_CALLS} max. Finalize with unverified_assumption flag.`,
    };
  }
  return { ok: true };
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
