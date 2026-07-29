import { type IPty } from "node-pty";
import type { AdapterDef, AgentCallResult } from "../agents/adapter.js";
import { callAgentStream, type AgentPTYStreamHandle } from "../agents/adapter-pty.js";
import type { PlannerResult } from "../planner/registry.js";
import { WorkflowRegistry } from "../planner/registry.js";
import { runWorkflow, type RunContext, type StepHandler, type StepOutcome } from "./step-runner.js";
import { checkStepBudget, detectLoop } from "./bounding.js";

import { Checkpointer, type StepResumeSnapshot } from "./Checkpointer.js";
import { Tracker } from "./Tracker.js";
import { StreamEmitter } from "../stream/emitter.js";
import { loadAgentSystemPrompts, type AgentSystemPrompt } from "../planner/prompt-loader.js";
import { setupProject } from "./bootstrap.js";
import { createHookFile, readHookEvents, removeHookFile } from "../hooks/endpoint.js";
import { registerCompletion } from "./StepCompletionRegistry.js";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { log } from "../log.js";

export interface RunReport {
  workflowId: string;
  source: "registered" | "dynamic" | "llm_classified" | "generated";
  outcomes: StepOutcome[];
  totalSteps: number;
  completed: number;
  failed: number;
}

export interface ProgressEvent {
  type: "step_start" | "step_complete" | "workflow_complete" | "error" | "step_pty";
  runId?: string;
  stepId?: string;
  agent?: string;
  task?: string;
  status?: string;
  duration?: number;
  error?: string;
  pty?: IPty;
  report?: RunReport;
}

interface StepSummary {
  summary: string;
  artifact: string;
  affectedFiles: string[];
}

interface OrcReturnResult {
  summary?: string;
  artifact?: string;
  affectedFiles?: string[];
  signal?: boolean;
}

function extractOrcResult(hooks: import("../hooks/types.js").HookEvent[]): OrcReturnResult | null {
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

export interface RunTracker {
  runId: string;
  tracker: Tracker;
}

export async function orchestrate(
  task: string,
  adapter: AdapterDef,
  plan: PlannerResult,
  resume?: boolean,
  tracker?: RunTracker,
  checkpointer?: Checkpointer,
  onProgress?: (event: ProgressEvent) => void,
): Promise<RunReport> {
  setupProject();
  const projectRoot = process.cwd();
  const cp = checkpointer ?? new Checkpointer(path.join(projectRoot, ".orc", "checkpoints.sqlite"));

  let report: RunReport | undefined;
  try {
  const activeAdapter = adapter;
  const runId = tracker?.runId;

  let sessionId: string;
  const restoredStepResults = new Map<string, StepOutcome>();

  if (resume) {
    const existing = cp.load(task);
    if (existing) {
      sessionId = existing.sessionId;
      for (const [stepId, r] of Object.entries(existing.stepResults)) {
        if (r.status !== "failed") {
          restoredStepResults.set(stepId, { stepId, status: r.status, output: r.output, error: r.error, retries: r.retries, hooks: r.hooks });
        }
      }
      log.info(`[resume] Restored ${restoredStepResults.size}/${Object.keys(existing.stepResults).length} completed steps (session=${sessionId})`);
      if (tracker) {
        const run = tracker.tracker.getRun(tracker.runId);
        if (run) {
          for (const [stepId, r] of restoredStepResults) {
            tracker.tracker.setStepCompleted(tracker.runId, stepId, r.status, r.error);
            onProgress?.({ type: "step_complete", runId: tracker.runId, stepId, status: r.status, error: r.error });
          }
        }
      }
    } else {
      sessionId = crypto.randomUUID();
      log.info(`[resume] No checkpoint found for "${task}", starting fresh`);
    }
  } else {
    sessionId = crypto.randomUUID();
  }

  const forAgent = (_name: string): AdapterDef => activeAdapter;

  const agentPrompts = loadAgentSystemPrompts();

  const allOutcomes: StepOutcome[] = [];
  const completedSummaries = new Map<string, StepSummary>();
  const emitter = new StreamEmitter();

  const handler: StepHandler = async (step, ctx) => {
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
        let hooks: import("../hooks/types.js").HookEvent[] = [];
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

  const ctx: RunContext = {
    workflowId: plan.workflow.workflow.id,
    stepResults: restoredStepResults,
    buildResults: new Map(),
    maxRetries: 2,
  };

  function collectCheckpoint(): Record<string, StepResumeSnapshot> {
    const out: Record<string, StepResumeSnapshot> = {};
    for (const [stepId, o] of ctx.stepResults) {
      out[stepId] = { status: o.status, output: o.output, error: o.error, retries: o.retries, hooks: o.hooks };
    }
    return out;
  }

  function saveCheckpoint() {
    cp.save(task, {
      workflowId: plan.workflow.workflow.id,
      sessionId,
      agentId: activeAdapter.id,
      stepResults: collectCheckpoint(),
      context: { task },
    });
  }

  const outcomes = await runWorkflow(
    plan.workflow.workflow.steps,
    handler,
    ctx,
    () => { saveCheckpoint(); },
  );

  saveCheckpoint();

  report = {
    workflowId: plan.workflow.workflow.id,
    source: plan.source,
    outcomes,
    totalSteps: outcomes.length,
    completed: outcomes.filter(o => o.status === "completed").length,
    failed: outcomes.filter(o => o.status === "failed").length,
  };

  if (tracker) {
    const finalStatus = report.failed > 0 ? "failed" as const : "completed" as const;
    tracker.tracker.updateRunStatus(tracker.runId, finalStatus);
  }

  onProgress?.({ type: "workflow_complete", runId, status: report.failed > 0 ? "failed" : "completed", report });

  return report;
  } finally {
    if (report && report.failed === 0) {
      cp.prune(task);
    }
    cp.close();
  }
}

function buildStepContext(step: import("../schemas.js").WorkflowStep, summaries: Map<string, StepSummary>, originalTask?: string, _agentInfo?: AgentSystemPrompt, completionKey?: string): string {
  const context = step.context ?? [];
  const depIds = context.length > 0 ? context : step.depends_on;
  const parts: string[] = [];
  if (originalTask) {
    parts.push(`=== Original Request ===\n${originalTask}`);
  }
  for (const depId of depIds) {
    const s = summaries.get(depId);
    if (!s) continue;
    parts.push(
      `=== ${depId} ===\n` +
      `Summary: ${s.summary}\n` +
      `Artifact: ${s.artifact}\n` +
      `Files: ${s.affectedFiles.join(", ") || "(none)"}`
    );
  }
  if (step.task) {
    parts.push(`=== Task ===\n${step.task}`);
  }
  const instructions: string[] = [
    `=== Response Instructions ===`,
    `When you are done, call the \`return_result\` tool with:`,
    `- summary: what you accomplished`,
    `- artifact: path to the generated artifact (or "" if none)`,
    `- affectedFiles: array of files created or modified`,
  ];
  if (completionKey) {
    instructions.push(`- completionKey: "${completionKey}" (MUST include this exact value)`);
  }
  const sig = step.signal;
  if (sig) {
    instructions.push(`- signal: boolean — ${sig.description} (true = satisfactory → continue, false = needs rework → retry upstream)`);
  }
  parts.push(instructions.join("\n"));
  return parts.join("\n\n");
}


