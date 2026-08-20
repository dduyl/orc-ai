import * as crypto from "node:crypto";
import type { AdapterDef, AgentCallResult } from "../../agents/adapter.js";
import { callAgentStream } from "../../agents/adapter-pty.js";
import type { AgentSystemPrompt } from "../../planner/prompt-loader.js";
import { CommandExecutor, type CommandExecutionResult } from "../execution/CommandExecutor.js";
import { compressGateOutput } from "../execution/output-compress.js";
import { commandsTomlPath } from "../persistence/bootstrap.js";
import { createHookFile, readHookEvents, removeHookFile } from "../../../adapters/hooks/endpoint.js";
import { registerCompletion, rejectCompletion, completionKeyExists } from "../signalling/StepCompletionRegistry.js";
import type { StepHandler, StepOutcome, RunContext } from "../execution/step-runner.js";
import type { WorkflowStep } from "../../../core/schemas.js";
import { StreamEmitter } from "../../../adapters/stream/emitter.js";
import { log } from "../../../core/log.js";
import { FailureReason } from "../../../core/types.js";
import { AgentCallError, classifyAgentError, toQuotaInfo, type QuotaInfo } from "../../agents/errors.js";
import { buildStepContext, buildResponseInstructions } from "./context-builder.js";
import type { OrcReturnResult, ProgressEvent, RunTracker, StepSummary } from "./types.js";
import { classifyComplexity, readRepoState } from "../../agents/complexity.js";
import type { Complexity, RepoState } from "../../agents/complexity.js";
import { loadModelRoutingConfig } from "../../agents/config.js";
import type { ModelRoutingConfig } from "../../agents/config.js";
import { resolveVariantTier, BUILTIN_TIERED_ROLES, type Tier } from "../../agents/variants.js";
import { readConfiguredProviders } from "../../agents/configured-providers.js";
import type { OnProviderQuota } from "../../agents/acp/types.js";

/** Bounded exponential backoff: 1s -> 2s -> 4s ... capped at 30s. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

/** Resolves when `ms` elapses — or immediately if `signal` aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Backoff for a transient failure: `Retry-After`/`retry_after` wins, else `base * 2^attempt`. */
function backoffFor(err: AgentCallError, attempt: number): number {
  if (typeof err.retryAfterMs === "number" && err.retryAfterMs > 0) {
    return Math.min(err.retryAfterMs, BACKOFF_CAP_MS);
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
}

function extractOrcResult(hooks: import("../../../core/hooks.js").HookEvent[]): OrcReturnResult | null {
  for (let i = hooks.length - 1; i >= 0; i--) {
    const h = hooks[i];
    if (h.type === "tool_call" && (h as any).tool === "return_result") {
      try {
        return JSON.parse((h as any).input);
      } catch { return null; }
    }
  }
  return null;
}

export function buildRepairPrompt(
  gateId: string,
  result: CommandExecutionResult,
  step: WorkflowStep,
  completionKey?: string,
): string {
  const blocks = result.groups.map((g, i) => {
    const lines = [
      `--- command ${i + 1}/${result.groups.length} ---`,
      `command: ${g.command}`,
      `exit code: ${g.exitCode}`,
    ];
    const compressed = compressGateOutput(g.stdout, g.stderr);
    if (compressed.changed) {
      lines.push(`[output compressed: ${compressed.originalChars} -> ${compressed.compressedChars} chars]`);
    }
    if (compressed.stdout) lines.push(`stdout:\n${compressed.stdout}`);
    if (compressed.stderr) lines.push(`stderr:\n${compressed.stderr}`);
    return lines.join("\n");
  });
  return [
    `=== PREVIOUS VALIDATION FAILURE — FIX REQUIRED ===`,
    `The '${gateId}' gate failed. Repair the issue, then re-run the validation.`,
    "",
    ...blocks,
    "",
    buildResponseInstructions(step, completionKey),
  ].join("\n");
}

export function createStepHandler(options: {
  adapter: AdapterDef;
  agentPrompts: Map<string, AgentSystemPrompt>;
  completedSummaries: Map<string, StepSummary>;
  emitter: StreamEmitter;
  task: string;
  tracker?: RunTracker;
  onProgress?: (event: ProgressEvent) => void;
  /** Injectable for tests; defaults to a CommandExecutor bound to commandsTomlPath(). */
  commandExecutor?: CommandExecutor;
  /**
   * ADR-022: seam consulted when a step's first agent call fails with a
   * quota error. Returning a non-empty model id different from `triedModel`
   * re-invokes the step once with that model via a same-session downgrade.
   * Returning undefined (or throwing) leaves the quota error to fail the step.
   */
  resolveDowngradeModel?: (role: string, triedModel: string) => string | undefined;
  /**
   * ADR-021: project root for the complexity classifier (git status
   * porcelain). Defaults to process.cwd().
   */
  projectRoot?: string;
  /**
   * ADR-021: the model-routing block of ~/.orc/config.json, pre-loaded.
   * Injectable for tests; defaults to loadModelRoutingConfig(). Also gates
   * whether a role is tiered: the git-based complexity read only runs for
   * roles that are tiered here or in BUILTIN_TIERED_ROLES, so the common
   * (untiered) path stays synchronous.
   */
  modelRoutingConfig?: ModelRoutingConfig;
  /**
   * ADR-021: seam consulted on every agent step to decide the model tier
   * ("cheap" | "strong") from the step's agent role + task complexity.
   * Injectable for tests; defaults to the real resolveVariantTier backed by
   * the model-routing block of ~/.orc/config.json.
   */
  resolveVariantTier?: (role: string, complexity: Complexity) => Tier;
  /**
   * ADR-021 (provider failover): seam forwarded to the ACP session when a
   * prompt hits a quota error and the agent advertises the `providers`
   * capability. A returned failover switches providers (`providers/list` +
   * `providers/set`) and re-runs the prompt on the new provider BEFORE the
   * same-session downgrade path; returning undefined (or throwing) leaves the
   * quota error to the downgrade/pause ladder. The PTY path accepts but never
   * invokes it. Injectable for tests; not wired by default (mirror of
   * `resolveDowngradeModel`).
   */
  onProviderQuota?: OnProviderQuota;
}): StepHandler {
  const { adapter, agentPrompts, completedSummaries, emitter, task, tracker, onProgress, commandExecutor, resolveDowngradeModel, projectRoot, modelRoutingConfig, resolveVariantTier: resolveTier, onProviderQuota } = options;
  const activeAdapter = adapter;
  const root = projectRoot ?? process.cwd();
  const routingConfig = modelRoutingConfig ?? loadModelRoutingConfig();
  const tierResolver = resolveTier ?? ((role: string, complexity: Complexity) => resolveVariantTier(role, complexity, routingConfig));
  // A role is tiered if the user configured a variants entry for it or it is a
  // builtin tiered role. Only tiered roles pay the git-read cost of the
  // complexity classifier; untiered roles resolve from an undefined repo state
  // (always "complex" -> never under-provisioned) with no I/O.
  const roleTiered = (role: string): boolean => Boolean(routingConfig.variants?.[role]) || BUILTIN_TIERED_ROLES.has(role);
  // The worktree does not change across retry attempts, so the repo state is
  // read at most once per run and shared by every tiered step.
  let repoStateCache: Promise<RepoState | undefined> | undefined;
  const repoState = (): Promise<RepoState | undefined> => (repoStateCache ??= readRepoState(root));
  // Providers the user has credentials for, produced once per run (user config
  // `providers` block + opencode auth.json) and threaded through to the ACP
  // session seam as the ADR-021 provider filter input.
  const configuredProviders = readConfiguredProviders(routingConfig);
  const forAgent = (_name: string): AdapterDef => activeAdapter;
  const runId = tracker?.runId;
  const executor = commandExecutor ?? new CommandExecutor(commandsTomlPath());

  /**
   * Emit the "cancelled" failure record for a step after an abort. Used by the
   * in-flight abort path and the retry catch (both already emitted stepStart).
   * The pre-dispatch abort check calls `cancelled` with `emitStream: false` —
   * no stepStart was emitted for that step, so a stepFinish would be a phantom.
   */
  function cancelled(stepId: string, attempt: number, emitStream: boolean): StepOutcome {
    const o: StepOutcome = { stepId, status: "failed", error: "cancelled", retries: attempt };
    tracker?.tracker.setStepCompleted(tracker.runId, stepId, "failed", "cancelled");
    onProgress?.({ type: "step_complete", runId, stepId, status: "failed", error: "cancelled" });
    if (emitStream) {
      emitter.stepFinish(stepId, "error", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
    }
    return o;
  }

  async function runScriptStep(
    step: WorkflowStep,
    ctx: RunContext,
  ): Promise<StepOutcome> {
    const run = step.run;
    let exec: { ok: false; error: string } | { ok: true; result: CommandExecutionResult };
    try {
      exec = run ? await executor.execute(run, ctx.signal) : { ok: false as const, error: `script step '${step.id}' has no 'run' expression` };
    } catch (err: any) {
      // The executor rejects with "cancelled" when the signal aborts mid-run.
      // stepStart was already emitted, so emit the stream finish ("cancelled"
      // failure) and a completed tracker row so the step isn't left "running".
      if (ctx.signal?.aborted) return cancelled(step.id, 0, true);
      throw err;
    }

    if (!exec.ok) {
      const err = exec.error;
      const o: StepOutcome = { stepId: step.id, status: "failed", error: err, retries: 0 };
      tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", err);
      onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "failed", error: err });
      emitter.stepFinish(step.id, "error", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
      return o;
    }

    const result = exec.result;
    const annotate = (g: { command: string; stdout?: string; stderr?: string }, pick: "stdout" | "stderr") => {
      const text = g[pick] ?? "";
      return text ? `$ ${g.command}\n${text}` : "";
    };
    const stdout = result.groups.map(g => annotate(g, "stdout")).filter(Boolean).join("\n");
    const stderr = result.groups.map(g => annotate(g, "stderr")).filter(Boolean).join("\n");
    ctx.buildResults.set(step.id, { exitCode: result.exitCode, stdout, stderr });
    completedSummaries.set(step.id, {
      summary: result.passed ? `Script gate passed (exit ${result.exitCode})` : `Script gate failed (exit ${result.exitCode})`,
      artifact: "",
      affectedFiles: [],
    });

    const passSignal = step.emits[0].name;
    const failSignal = step.emits[1].name;
    const failRef = `${step.id}.${failSignal}`;
    if (result.passed) ctx.repairFeedbacks.delete(failRef);
    else ctx.repairFeedbacks.set(failRef, { gateId: step.id, result });

    const o: StepOutcome = {
      stepId: step.id,
      status: "completed",
      signal: result.passed ? passSignal : failSignal,
      retries: 0,
    };
    if (result.passed) {
      tracker?.tracker.setStepCompleted(tracker.runId, step.id, "completed");
      onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "completed" });
    } else {
      // F10: a failing gate stays "completed" for graph routing (its fail signal
      // triggers a redo), but the report must show WHY instead of a silent pass.
      o.error = `Script gate '${step.id}' failed (exit ${result.exitCode}) — emitted '${failSignal}'`;
      tracker?.tracker.setStepCompleted(tracker.runId, step.id, "completed", o.error);
      onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "completed", error: o.error });
    }
    emitter.stepFinish(step.id, result.passed ? "stop" : "error", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
    return o;
  }

  return async (step, ctx) => {
    if (ctx.signal?.aborted) {
      // Cancelled before this step started: no stepStart was emitted, so mark
      // the tracker/feed only and skip the stream finish. The runner's
      // tryFinish marks the remaining un-run tail the same way.
      return cancelled(step.id, 0, false);
    }

    emitter.stepStart(step.id);

    tracker?.tracker.setStepRunning(tracker.runId, step.id);
    onProgress?.({ type: "step_start", runId, stepId: step.id, agent: step.agent, task: step.task });

    if (step.type === "script") {
      return await runScriptStep(step, ctx);
    }

    // ADR-021: task complexity from the repo state, computed once per step —
    // the worktree does not change across retry attempts. The git read is
    // gated on the role being tiered (see roleTiered): untiered roles classify
    // from an undefined repo state as "complex" so they are never
    // under-provisioned, and the common path stays synchronous.
    const role = step.agent ?? "";
    const complexity = roleTiered(role)
      ? classifyComplexity(task, await repoState())
      : classifyComplexity(task, undefined);

    let downgradeTried = false;
    let downgradeTo: string | undefined;

    // While-loop (not for): the quota downgrade re-invokes the SAME attempt
    // without consuming a transient-retry slot, so only the transient backoff
    // path increments `attempt`.
    let attempt = 0;
    while (attempt <= ctx.maxRetries) {
      try {
        const name = step.agent;
        if (!name) {
          const o: StepOutcome = { stepId: step.id, status: "failed", error: `agent step '${step.id}' missing 'agent'`, retries: attempt };
          tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", `agent step '${step.id}' missing 'agent'`);
          onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "failed", error: `agent step '${step.id}' missing 'agent'` });
          emitter.stepFinish(step.id, "error", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
          return o;
        }
        const agentInfo = agentPrompts.get(name);
        if (!agentInfo) {
          const o: StepOutcome = { stepId: step.id, status: "failed", error: `Unknown agent: ${name}`, retries: attempt };
          tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", `Unknown agent: ${name}`);
          onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "failed", error: `Unknown agent: ${name}` });
          emitter.stepFinish(step.id, "error", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
          return o;
        }

        const completionKey = crypto.randomUUID();
        const callFor = forAgent(name);

        // ADR-021: decide the model tier at the call boundary (not inside
        // `forAgent`, which returns the active AdapterDef and ignores its
        // argument). The tier is carried to callAgentStream; the ACP session
        // model is configured from it pre-emptively. A user override
        // (`variants.<agent>.<tier>`) becomes a concrete `variantModel`; a
        // bare tier biases the ACP selection to the cheapest-of-tier
        // advertised model, and the PTY path logs the intent + tool default.
        const tier = tierResolver(name, complexity);
        const variantModel = routingConfig.variants?.[name]?.[tier]?.trim() || undefined;
        log.debug(`step ${step.id}: role '${name}' complexity '${complexity}' -> tier '${tier}'${variantModel ? ` model '${variantModel}'` : ""}`);

        let result: AgentCallResult;
        let hooks: import("../../../core/hooks.js").HookEvent[] = [];
        let orcResult: OrcReturnResult | null = null;

        const repair = ctx.pendingRepair;
        const combinedPrompt = repair
          ? agentInfo.systemPrompt + "\n\n" + buildRepairPrompt(repair.gateId, repair.result, step, completionKey)
          : agentInfo.systemPrompt + "\n\n" + buildStepContext(step, completedSummaries, task, agentInfo, completionKey);
        const hookFile = createHookFile(step.id);
        try {
          const handle = callAgentStream(callFor, combinedPrompt, hookFile, downgradeTo, tier, variantModel, configuredProviders, onProviderQuota);
          onProgress?.({ type: "step_pty", runId, stepId: step.id, pty: handle.pty });
          const abortSignal = ctx.signal;
          // Register before attaching the abort listener: the sync aborted
          // check + addEventListener below leave no await window where an
          // abort could be missed after the key exists.
          const mcpDone = registerCompletion(completionKey);
          const onAbort = () => {
            try { handle.pty.kill(); } catch { /* ignore */ }
            // H1/H2: settle the Promise.race even if node-pty never fires
            // onExit after kill() (e.g. win32 bash.exe-wrapped spawn). This
            // deletes the registry entry (no leak) and rejects the MCP bridge
            // so a cancelled step can't hang the run forever.
            if (completionKeyExists(completionKey)) {
              rejectCompletion(completionKey, new Error("cancelled"));
            }
          };
          if (abortSignal?.aborted) onAbort();
          else abortSignal?.addEventListener("abort", onAbort, { once: true });
          try {
            const raceResult = await Promise.race([handle.promise, mcpDone]);
            if (typeof (raceResult as any).content !== "string") {
              const mcpData = raceResult as OrcReturnResult;
              const mcpOutput = JSON.stringify(mcpData);
              result = { content: mcpOutput, model: activeAdapter.id, tokensUsed: 0, duration: 0 };
              orcResult = mcpData;
              handle.promise.catch(() => {});
            } else {
              result = raceResult as AgentCallResult;
            }
          } finally {
            if (abortSignal && !abortSignal.aborted) abortSignal.removeEventListener("abort", onAbort);
          }
        } finally {
          hooks = readHookEvents(hookFile);
          removeHookFile(hookFile);
        }
        if (ctx.signal?.aborted) {
          // Cancelled mid-call: the PTY was killed and the completion deferred
          // rejected above; never treat the partial output as a completed step
          // or let it emit a signal.
          return cancelled(step.id, attempt, true);
        }
        if (!orcResult) orcResult = extractOrcResult(hooks);
        const output = result.content;
        emitter.text(step.id, output);
        const summary: StepSummary = orcResult
          ? {
              summary: orcResult.summary || "(no structured summary)",
              artifact: orcResult.artifact || "",
              affectedFiles: orcResult.affectedFiles || [],
            }
          : { summary: "(no return_result)", artifact: "", affectedFiles: [] };
        completedSummaries.set(step.id, summary);

        const o: StepOutcome = {
          stepId: step.id,
          status: "completed",
          output,
          retries: attempt,
          hooks,
          summary: summary.summary,
          artifact: summary.artifact,
          affectedFiles: summary.affectedFiles,
          signal: orcResult?.signal,
          ...(result.downgradedTo ? { downgradedTo: result.downgradedTo } : {}),
        };
        if (result.downgradedTo) {
          log.info(`step '${step.id}' quota — completed on downgraded model '${result.downgradedTo}'`);
        }
        tracker?.tracker.setStepCompleted(tracker.runId, step.id, "completed");
        onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "completed", duration: result.duration });
        emitter.stepFinish(step.id, "stop", "", { total: 0, input: 0, output: output.length, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
        return o;
      } catch (err: any) {
        if (ctx.signal?.aborted) {
          // Includes the rejectCompletion("cancelled") path from onAbort —
          // the race rejected before handle.promise settled, so bail cleanly.
          return cancelled(step.id, attempt, true);
        }
        const agentErr = err instanceof AgentCallError ? err : classifyAgentError(err);
        const fail = (extra: Partial<StepOutcome> = {}, quota?: QuotaInfo): StepOutcome => {
          const o: StepOutcome = { stepId: step.id, status: "failed", error: agentErr.message, retries: attempt, ...extra };
          const trackerError = quota ? `[quota] ${agentErr.message}` : agentErr.message;
          tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", trackerError, quota);
          onProgress?.({
            type: "step_complete",
            runId,
            stepId: step.id,
            status: "failed",
            error: agentErr.message,
            ...(quota ? { quota } : {}),
          });
          emitter.stepFinish(step.id, quota ? "quota" : "error", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0, quota);
          return o;
        };
        // ADR-022 retry policy — kind-aware, never blind:
        //  - quota:     do NOT retry (backing off against a quota is wasted). Fail
        //               immediately with QuotaExhausted and carry the payload.
        //  - auth:      fail fast — retrying won't clear a bad key.
        //  - rate_limit / connection / spawn / unknown: bounded backoff, then fail.
        switch (agentErr.kind) {
          case "quota": {
            // ADR-022: one same-session model downgrade is allowed
            // before giving up on the step. The callback is consulted at most
            // once per step; a valid variant re-invokes the SAME attempt with
            // `downgradeTo` (no backoff — backing off against a quota is wasted).
            if (!downgradeTried && resolveDowngradeModel) {
              let variant: string | undefined;
              try {
                variant = resolveDowngradeModel(step.agent ?? "", activeAdapter.id);
              } catch (cbErr) {
                log.warn(`step '${step.id}' quota — resolveDowngradeModel threw: ${(cbErr as Error).message}`);
              }
              const trimmed = typeof variant === "string" ? variant.trim() : "";
              if (trimmed === "" || trimmed === activeAdapter.id) {
                log.warn(`step '${step.id}' quota — resolveDowngradeModel returned no usable model ('${variant ?? ""}'), failing step`);
              } else {
                downgradeTried = true;
                downgradeTo = trimmed;
                log.info(`step '${step.id}' quota — downgrading model '${activeAdapter.id}' -> '${downgradeTo}'`);
                continue;
              }
            }
            const quotaInfo = toQuotaInfo(agentErr, downgradeTried && downgradeTo ? downgradeTo : undefined);
            // ADR-022: quota remains with no recovery path (no
            // usable downgrade callback, or the downgraded retry hit quota again)
            // — the run PAUSES instead of failing. The tracker still records the
            // step as "failed" (the resume path re-runs it and the `[quota]`
            // marker persists), but the outcome/progress surface the paused state
            // so the daemon can auto-resume once the quota window resets.
            const pausedOutcome: StepOutcome = {
              stepId: step.id,
              status: "paused",
              error: agentErr.message,
              retries: attempt,
              failureReason: FailureReason.QuotaExhausted,
              quota: quotaInfo,
              ...(quotaInfo.downgradedTo ? { downgradedTo: quotaInfo.downgradedTo } : {}),
            };
            tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", `[quota] ${agentErr.message}`, quotaInfo);
            onProgress?.({
              type: "step_complete",
              runId,
              stepId: step.id,
              status: "paused",
              error: agentErr.message,
              quota: quotaInfo,
            });
            emitter.stepFinish(step.id, "quota", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0, quotaInfo);
            return pausedOutcome;
          }
          case "auth":
            return fail();
          default:
            if (attempt < ctx.maxRetries) {
              const waitMs = backoffFor(agentErr, attempt);
              log.info(`step '${step.id}' ${agentErr.kind} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${ctx.maxRetries})`);
              await sleep(waitMs, ctx.signal);
              // A cancel issued during the backoff must take effect the moment
              // the wait ends — do NOT re-dispatch another agent call.
              if (ctx.signal?.aborted) return cancelled(step.id, attempt, true);
              attempt++;
              continue;
            }
            return fail();
        }
      }
    }

    const o: StepOutcome = { stepId: step.id, status: "failed", error: "max retries", retries: ctx.maxRetries };
    tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", "max retries");
    onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "failed", error: "max retries" });
    emitter.stepFinish(step.id, "max_retries", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
    return o;
  };
}
