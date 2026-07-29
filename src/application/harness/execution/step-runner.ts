import type { WorkflowStep } from "../../../core/schemas.js";
import type { HookEvent } from "../../../core/hooks.js";
import { log } from "../../../core/log.js";

export interface RunContext {
  workflowId: string;
  stepResults: Map<string, StepOutcome>;
  buildResults: Map<string, { exitCode: number; stdout: string; stderr: string }>;
  maxRetries: number;
}

export interface StepOutcome {
  stepId: string;
  status: "completed" | "failed";
  output?: string;
  error?: string;
  retries: number;
  hooks?: HookEvent[];
  signal?: boolean;
  /** Structured result from orc_return_result, populated by orchestrator */
  summary?: string;
  artifact?: string;
  affectedFiles?: string[];
}

export type StepHandler = (step: WorkflowStep, ctx: RunContext) => Promise<StepOutcome>;

export function resolveReady(steps: WorkflowStep[], ctx: RunContext): WorkflowStep[] {
  return steps.filter(s => {
    if (ctx.stepResults.has(s.id)) return false;
    const deps = s.depends_on;
    return deps.length === 0 || deps.every(d => {
      const r = ctx.stepResults.get(d);
      return r && r.status === "completed";
    });
  });
}

export async function runWorkflow(
  steps: WorkflowStep[],
  handler: StepHandler,
  ctx: RunContext,
  onStepComplete?: (step: WorkflowStep, outcome: StepOutcome) => void,
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  const stepMap = new Map(steps.map(s => [s.id, s]));
  const pending = new Set(steps.map(s => s.id));
  const running = new Set<string>();
  let finished = false;
  let resolvePromise: (v: StepOutcome[]) => void;

  const p = new Promise<StepOutcome[]>(resolve => { resolvePromise = resolve; });

  function allStepsDone(): boolean {
    return steps.every(s => ctx.stepResults.has(s.id));
  }

  function cascadeReset(targetId: string) {
    const stack = [targetId];
    while (stack.length) {
      const id = stack.pop()!;
      if (!ctx.stepResults.has(id)) continue;
      ctx.stepResults.delete(id);
      pending.add(id);
      running.delete(id);
      for (const s of steps) {
        if (s.depends_on.includes(id)) stack.push(s.id);
      }
    }
  }

  function tryFinish() {
    if (allStepsDone() && running.size === 0 && !finished) {
      finished = true;
      resolvePromise(outcomes);
    }
  }

  function handleDeadlocks() {
    if (running.size > 0) return;
    for (const s of steps) {
      if (!pending.has(s.id) || s.depends_on.length === 0) continue;
      const blocked = s.depends_on.some(d => {
        const r = ctx.stepResults.get(d);
        return r ? r.status !== "completed" : true;
      });
      if (blocked) {
        pending.delete(s.id);
        const o: StepOutcome = { stepId: s.id, status: "failed", error: "Unresolved dependency", retries: 0 };
        ctx.stepResults.set(s.id, o);
        outcomes.push(o);
        onStepComplete?.(s, o);
      }
    }
    tryFinish();
  }

  async function maybeRun(step: WorkflowStep) {
    if (!pending.has(step.id) || running.has(step.id)) return;
    if (!step.depends_on.every(d => {
      const r = ctx.stepResults.get(d);
      return r && r.status === "completed";
    })) return;

    pending.delete(step.id);
    running.add(step.id);

    const outcome = await handler(step, ctx);

    running.delete(step.id);
    ctx.stepResults.set(step.id, outcome);
    const existingIdx = outcomes.findIndex(o => o.stepId === step.id);
    if (existingIdx >= 0) outcomes[existingIdx] = outcome;
    else outcomes.push(outcome);
    onStepComplete?.(step, outcome);

    if (step.signal && outcome.signal !== undefined) {
      const targetId = outcome.signal ? step.signal.signal_on : step.signal.signal_off;
      log.info(`[step-runner] signal loopback: step=${step.id} signal=${outcome.signal} targetId=${targetId}`);
      if (targetId) {
        if (!outcome.signal) {
          log.info(`[step-runner] cascade reset starting from ${targetId}`);
          cascadeReset(targetId);
        }
        const target = stepMap.get(targetId);
        if (target) {
          log.info(`[step-runner] re-running target step ${target.id}`);
          maybeRun(target);
        }
      }
    }

    for (const s of steps) {
      if (s.depends_on.includes(step.id)) maybeRun(s);
    }

    handleDeadlocks();
    tryFinish();
  }

  for (const step of steps) maybeRun(step);
  handleDeadlocks();

  setTimeout(() => {
    if (finished) return;
    handleDeadlocks();
    if (!allStepsDone() && running.size === 0) {
      for (const id of pending) {
        const s = stepMap.get(id)!;
        pending.delete(id);
        const o: StepOutcome = { stepId: id, status: "failed", error: "Deadlock: unresolvable dependency chain", retries: 0 };
        ctx.stepResults.set(id, o);
        outcomes.push(o);
        onStepComplete?.(s, o);
      }
      tryFinish();
    }
  }, 5000);

  return p;
}
