import * as crypto from "node:crypto";
import type { AdapterDef, AgentCallResult } from "../../agents/adapter.js";
import { callAgentStream } from "../../agents/adapter-pty.js";
import type { AgentSystemPrompt } from "../../planner/prompt-loader.js";
import { checkStepBudget, detectLoop } from "../execution/bounding.js";
import { createHookFile, readHookEvents, removeHookFile } from "../../../adapters/hooks/endpoint.js";
import { registerCompletion } from "../signalling/StepCompletionRegistry.js";
import type { StepHandler, StepOutcome } from "../execution/step-runner.js";
import { StreamEmitter } from "../../../adapters/stream/emitter.js";
import { log } from "../../../core/log.js";
import { buildStepContext } from "./context-builder.js";
import type { OrcReturnResult, ProgressEvent, RunTracker, StepSummary } from "./types.js";

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

export function createStepHandler(options: {
  adapter: AdapterDef;
  agentPrompts: Map<string, AgentSystemPrompt>;
  completedSummaries: Map<string, StepSummary>;
  allOutcomes: StepOutcome[];
  emitter: StreamEmitter;
  task: string;
  tracker?: RunTracker;
  onProgress?: (event: ProgressEvent) => void;
}): StepHandler {
  const { adapter, agentPrompts, completedSummaries, allOutcomes, emitter, task, tracker, onProgress } = options;
  const activeAdapter = adapter;
  const forAgent = (_name: string): AdapterDef => activeAdapter;
  const runId = tracker?.runId;

  return async (step, ctx) => {
    emitter.stepStart(step.id);

    const budget = checkStepBudget(ctx.stepResults.size);
    if (!budget.ok) {
      const o: StepOutcome = { stepId: step.id, status: "failed", error: budget.error, retries: 0 };
      tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", budget.error);
      onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "failed", error: budget.error });
      emitter.stepFinish(step.id, "budget_exceeded", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
      return o;
    }

    const loop = detectLoop(allOutcomes);
    if (!loop.ok) {
      const o: StepOutcome = { stepId: step.id, status: "failed", error: loop.error, retries: 0 };
      tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", loop.error);
      onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "failed", error: loop.error });
      emitter.stepFinish(step.id, "loop_detected", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
      return o;
    }

    tracker?.tracker.setStepRunning(tracker.runId, step.id);
    onProgress?.({ type: "step_start", runId, stepId: step.id, agent: step.agent, task: step.task });

    for (let attempt = 0; attempt <= ctx.maxRetries; attempt++) {
      try {
        const name = step.agent;
        const agentInfo = agentPrompts.get(name);
        if (!agentInfo) {
          const o: StepOutcome = { stepId: step.id, status: "failed", error: `Unknown agent: ${name}`, retries: attempt };
          tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", `Unknown agent: ${name}`);
          onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "failed", error: `Unknown agent: ${name}` });
          emitter.stepFinish(step.id, "error", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
          return o;
        }

        const completionKey = crypto.randomUUID();
        const context = buildStepContext(step, completedSummaries, task, agentInfo, completionKey);
        const callFor = forAgent(name);

        let result: AgentCallResult;
        let hooks: import("../../../core/hooks.js").HookEvent[] = [];
        let orcResult: OrcReturnResult | null = null;

        const combinedPrompt = agentInfo.systemPrompt + "\n\n" + context;
        const hookFile = createHookFile(step.id);
        try {
          const handle = callAgentStream(callFor, combinedPrompt, hookFile);
          onProgress?.({ type: "step_pty", runId, stepId: step.id, pty: handle.pty });
          const mcpDone = registerCompletion(completionKey);
          const raceResult = await Promise.race([handle.promise, mcpDone]);
          if (typeof (raceResult as any).content !== "string") {
            const mcpData = raceResult as OrcReturnResult;
            log.info(`[step ${step.id}] MCP return_result won the race, killing sub-agent PTY`);
            try { handle.pty.kill(); } catch {}
            const ptyResult = await handle.promise;
            const mcpOutput = JSON.stringify(mcpData);
            result = { content: mcpOutput, model: ptyResult.model, tokensUsed: ptyResult.tokensUsed, duration: ptyResult.duration };
            orcResult = mcpData;
          } else {
            result = raceResult as AgentCallResult;
          }
        } finally {
          hooks = readHookEvents(hookFile);
          removeHookFile(hookFile);
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
          signal: orcResult?.signal
        };
        tracker?.tracker.setStepCompleted(tracker.runId, step.id, "completed");
        onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "completed", duration: result.duration });
        emitter.stepFinish(step.id, "stop", "", { total: 0, input: 0, output: output.length, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
        return o;
      } catch (err: any) {
        if (attempt < ctx.maxRetries) continue;
        const o: StepOutcome = { stepId: step.id, status: "failed", error: err.message, retries: attempt };
        tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", err.message);
        onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "failed", error: err.message });
        emitter.stepFinish(step.id, "error", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
        return o;
      }
    }

    const o: StepOutcome = { stepId: step.id, status: "failed", error: "max retries", retries: ctx.maxRetries };
    tracker?.tracker.setStepCompleted(tracker.runId, step.id, "failed", "max retries");
    onProgress?.({ type: "step_complete", runId, stepId: step.id, status: "failed", error: "max retries" });
    emitter.stepFinish(step.id, "max_retries", "", { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } }, 0);
    return o;
  };
}
