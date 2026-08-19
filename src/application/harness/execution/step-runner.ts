import { START_SIGNAL, validateWorkflowGraph, type WorkflowStep } from "../../../core/schemas.js";
import type { HookEvent } from "../../../core/hooks.js";
import type { CommandExecutionResult } from "./CommandExecutor.js";
import type { QuotaInfo } from "../../agents/errors.js";
import { log } from "../../../core/log.js";

export interface RunContext {
  workflowId: string;
  stepResults: Map<string, StepOutcome>;
  buildResults: Map<string, { exitCode: number; stdout: string; stderr: string }>;
  maxRetries: number;
  /**
   * Fail-signal ref (`gateId.signalName`) -> latest gate failure. Populated by
   * script gates that exit non-zero and read by the runner to feed a redo step.
   */
  repairFeedbacks: Map<string, RepairFeedback>;
  /** Transient: the repair feedback attached to the step's current dispatch. */
  pendingRepair?: RepairFeedback;
  /**
   * Cooperative cancellation. When aborted the scheduler stops dispatching
   * new steps; in-flight steps settle via the handler (agent calls kill their
   * PTY), then the run resolves. Un-run steps are marked failed "cancelled".
   */
  signal?: AbortSignal;
}

export interface RepairFeedback {
  gateId: string;
  result: CommandExecutionResult;
}

export interface StepOutcome {
  stepId: string;
  status: "completed" | "failed";
  output?: string;
  error?: string;
  retries: number;
  hooks?: HookEvent[];
  /** The single signal name the step emitted (one of its `emits`), or undefined when the step failed. */
  signal?: string;
  /** Structured result from orc_return_result, populated by orchestrator */
  summary?: string;
  artifact?: string;
  affectedFiles?: string[];
  /** ADR-022: reason the step failed (e.g. `quota_exhausted`) when the error is classified. */
  failureReason?: string;
  /** ADR-022: zod-valid quota payload when the step failed because the provider quota is exhausted. */
  quota?: QuotaInfo;
}

export type StepHandler = (step: WorkflowStep, ctx: RunContext) => Promise<StepOutcome>;

function refProducers(refs: string[]): string[] {
  const ids = refs.map(r => refsProducerId(r)).filter(id => id !== START_SIGNAL);
  return [...new Set(ids)];
}

/** The step id a signal ref points at. `__start__` is its own producer. */
function refsProducerId(ref: string): string {
  if (ref === START_SIGNAL) return START_SIGNAL;
  return ref.slice(0, ref.lastIndexOf("."));
}

export async function runWorkflow(
  steps: WorkflowStep[],
  handler: StepHandler,
  ctx: RunContext,
  onStepComplete?: (step: WorkflowStep, outcome: StepOutcome) => void,
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  const stepMap = new Map(steps.map(s => [s.id, s]));

  // Load-time graph validation: an unresolvable workflow must fail to run at all.
  const issues = validateWorkflowGraph({ version: 1, workflow: { id: ctx.workflowId, name: ctx.workflowId, steps, completion: "" } });
  if (issues.length) {
    throw new Error(
      `Workflow '${ctx.workflowId}' failed graph validation: ` + issues.map(i => i.message).join("; "),
    );
  }

  // emitted: signal ref (`stepId.signal`, or `__start__`) -> emission count.
  // consumed[consumerId][ref] -> emissions the consumer has already consumed.
  const emitted = new Map<string, number>();
  emitted.set(START_SIGNAL, 1);
  const consumed = new Map<string, Map<string, number>>();
  for (const s of steps) {
    const m = new Map<string, number>();
    for (const ref of [...(s.on ?? []), ...(s.any ?? [])]) m.set(ref, 0);
    consumed.set(s.id, m);
  }
  const emitNames = new Map<string, Set<string>>();
  for (const s of steps) emitNames.set(s.id, new Set(s.emits.map(e => e.name)));

  const running = new Set<string>();
  let finished = false;
  let resolvePromise!: (v: StepOutcome[]) => void;
  const p = new Promise<StepOutcome[]>(resolve => { resolvePromise = resolve; });

  const MAX_STEP_RUNS = 5;
  const MAX_TOTAL_RUNS = 50;
  const stepRunCounts = new Map<string, number>();
  const terminal = new Set<string>();
  let totalRuns = 0;

  function emittedRefCount(ref: string): number {
    return emitted.get(ref) ?? 0;
  }

  function isReady(s: WorkflowStep): boolean {
    if (terminal.has(s.id)) return false;
    if (running.has(s.id)) return false;
    const c = consumed.get(s.id)!;
    if (s.any && s.any.length > 0) {
      return s.any.some(ref => emittedRefCount(ref) > (c.get(ref) ?? 0));
    }
    return (s.on ?? []).every(ref => emittedRefCount(ref) > (c.get(ref) ?? 0));
  }

  function consumeRefs(s: WorkflowStep) {
    const c = consumed.get(s.id)!;
    for (const ref of [...(s.on ?? []), ...(s.any ?? [])]) {
      c.set(ref, emittedRefCount(ref));
    }
  }

  /** The refs that became newly satisfiable for this dispatch (count grew since last consume). */
  function firedRefs(s: WorkflowStep): string[] {
    const c = consumed.get(s.id)!;
    const fired: string[] = [];
    for (const ref of [...(s.on ?? []), ...(s.any ?? [])]) {
      if (emittedRefCount(ref) > (c.get(ref) ?? 0)) fired.push(ref);
    }
    return fired;
  }

  /**
   * Attach the repair feedback that belongs to THIS dispatch only. A redo step
   * re-fires because a fail ref's count grew; matching against just the
   * newly-fired refs prevents picking an arbitrary (stale) feedback when the
   * step listens on several fail signals.
   */
  function attachRepair(s: WorkflowStep) {
    for (const ref of firedRefs(s)) {
      const fb = ctx.repairFeedbacks.get(ref);
      if (fb) { ctx.pendingRepair = fb; return; }
    }
    ctx.pendingRepair = undefined;
  }

  function upsertOutcome(o: StepOutcome) {
    const idx = outcomes.findIndex(x => x.stepId === o.stepId);
    if (idx >= 0) outcomes[idx] = o;
    else outcomes.push(o);
  }

  /** True when a step can never run again: every branch it depends on is terminal. */
  function isUnfiable(id: string): boolean {
    const s = stepMap.get(id);
    if (!s) return false;
    const refs = [...(s.on ?? []), ...(s.any ?? [])];
    if (refs.length === 0) return true;
    return refs.every(ref => {
      const p = refsProducerId(ref);
      // `__start__` never fails, so a step seeded by it is always runnable.
      return p !== START_SIGNAL && terminal.has(p);
    });
  }

  /**
   * Mark the downstream cascade of a failed step as failed so the run reports
   * the full abort. Only steps that can no longer satisfy any signal branch are
   * failed — an OR consumer that still has a live branch is left untouched so
   * it can run. Previously-completed (non-terminal) consumers on the dead
   * branch are re-marked failed, fixing stale "completed" reports.
   */
  function propagateFailure(failedId: string) {
    const stack = [failedId];
    while (stack.length) {
      const id = stack.pop()!;
      for (const s of steps) {
        if (terminal.has(s.id)) continue;
        const consumes = (s.on ?? []).some(r => refsProducerId(r) === id)
          || (s.any ?? []).some(r => refsProducerId(r) === id);
        if (!consumes) continue;
        if (!isUnfiable(s.id)) continue;
        const o: StepOutcome = { stepId: s.id, status: "failed", error: `upstream step '${id}' failed`, retries: 0 };
        ctx.stepResults.set(s.id, o);
        terminal.add(s.id);
        upsertOutcome(o);
        onStepComplete?.(s, o);
        stack.push(s.id);
      }
    }
  }

  function failOutcome(s: WorkflowStep, error: string): StepOutcome {
    const o: StepOutcome = { stepId: s.id, status: "failed", error, retries: 0 };
    ctx.stepResults.set(s.id, o);
    terminal.add(s.id);
    upsertOutcome(o);
    onStepComplete?.(s, o);
    return o;
  }

  async function maybeRun(s: WorkflowStep) {
    if (ctx.signal?.aborted) return;
    if (running.has(s.id)) return;
    if (!isReady(s)) return;

    totalRuns++;
    if (totalRuns > MAX_TOTAL_RUNS) {
      failOutcome(s, `step budget exceeded: ${totalRuns} total runs > ${MAX_TOTAL_RUNS} max`);
      propagateFailure(s.id);
      pump();
      tryFinish();
      return;
    }
    const runs = (stepRunCounts.get(s.id) ?? 0) + 1;
    if (runs > MAX_STEP_RUNS) {
      failOutcome(s, `loop detected: step '${s.id}' ran ${runs} times > ${MAX_STEP_RUNS} max`);
      propagateFailure(s.id);
      pump();
      tryFinish();
      return;
    }
    stepRunCounts.set(s.id, runs);

    running.add(s.id);
    attachRepair(s);

    let outcome: StepOutcome;
    try {
      outcome = await handler(s, ctx);
    } catch (err: any) {
      // The handler must never kill the run: a throwing step becomes a normal
      // failed outcome, its consumers are failed via propagateFailure, and the
      // scheduler keeps pumping. Without this, running/consumed state leaks and
      // the run promise never resolves (a stuck "running" workflow).
      ctx.pendingRepair = undefined;
      running.delete(s.id);
      failOutcome(s, `step '${s.id}' failed during execution: ${err?.message ?? err}`);
      propagateFailure(s.id);
      pump();
      tryFinish();
      return;
    }
    ctx.pendingRepair = undefined;
    running.delete(s.id);

    if (outcome.status === "completed") {
      const signal = outcome.signal;
      const valid = signal !== undefined && emitNames.get(s.id)!.has(signal);
      if (!valid) {
        const o: StepOutcome = {
          ...outcome,
          status: "failed",
          error: outcome.error || `step '${s.id}' completed without emitting a valid signal (emits: ${[...emitNames.get(s.id)!].join(", ")})`,
        };
        ctx.stepResults.set(s.id, o);
        terminal.add(s.id);
        upsertOutcome(o);
        onStepComplete?.(s, o);
        propagateFailure(s.id);
        pump();
        tryFinish();
        return;
      }
      const ref = `${s.id}.${signal}`;
      emitted.set(ref, (emitted.get(ref) ?? 0) + 1);
      log.info(`[step-runner] ${s.id} emitted '${signal}'`);
    }

    ctx.stepResults.set(s.id, outcome);
    upsertOutcome(outcome);
    onStepComplete?.(s, outcome);

    if (outcome.status === "failed") {
      terminal.add(s.id);
      propagateFailure(s.id);
    } else {
      consumeRefs(s);
    }

    pump();
    tryFinish();
  }

  /**
   * Fan out one dispatch attempt per ready step. Execution is concurrent, so in
   * diamond graphs the relative completion order of parallel branches (and thus
   * which redo generation a downstream step observes) is timing-dependent. The
   * builtin workflows are linear chains where this is benign; `consumed`/`emitted`
   * counts keep the scheduler correct regardless of order.
   */
  function pump() {
    for (const s of steps) {
      void maybeRun(s).catch((err: any) => {
        // Defensive: an unexpected scheduler crash must not leave the run hanging.
        log.error(`[step-runner] step '${s.id}' crashed the scheduler: ${err?.message ?? err}`);
        if (!terminal.has(s.id)) {
          failOutcome(s, `step '${s.id}' crashed the scheduler: ${err?.message ?? err}`);
          propagateFailure(s.id);
        }
        running.delete(s.id);
        tryFinish();
      });
    }
  }

  function tryFinish() {
    if (finished) return;
    if (running.size > 0) return;
    if (!ctx.signal?.aborted && steps.some(s => isReady(s))) return;
    finished = true;
    if (ctx.signal?.aborted) {
      // Cancel the run cleanly: every step that will never dispatch is failed
      // "cancelled" so the report and checkpoints reflect the full workflow
      // instead of silently dropping the un-run tail.
      for (const s of steps) {
        if (terminal.has(s.id)) continue;
        if (ctx.stepResults.has(s.id)) continue;
        const o: StepOutcome = { stepId: s.id, status: "failed", error: "cancelled", retries: 0 };
        ctx.stepResults.set(s.id, o);
        upsertOutcome(o);
        onStepComplete?.(s, o);
      }
    }
    resolvePromise(outcomes);
  }

  pump();
  tryFinish();
  return p;
}
