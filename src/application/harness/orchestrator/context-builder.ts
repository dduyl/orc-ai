import type { AgentSystemPrompt } from "../../planner/prompt-loader.js";
import type { WorkflowStep } from "../../../core/schemas.js";
import type { StepSummary } from "./types.js";

export function buildResponseInstructions(
  step: WorkflowStep,
  completionKey?: string,
): string {
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
  if (step.emits && step.emits.length > 0) {
    instructions.push(`- signal: ONE signal name chosen from this step's output signals — pick exactly one of:`);
    for (const e of step.emits) {
      instructions.push(`  - "${e.name}" — ${e.description}`);
    }
    instructions.push(`This step ONLY emits a signal; it never names its consumers. The runner routes downstream steps from the signal you choose.`);
  }
  return instructions.join("\n");
}

/** Producers referenced by a step's `on`/`any` signal refs. */
function producersFromRefs(step: WorkflowStep): string[] {
  const ids = [...(step.on ?? []), ...(step.any ?? [])]
    .map(r => r.split(".")[0])
    .filter(id => id !== "__start__");
  return [...new Set(ids)];
}

export function buildStepContext(
  step: WorkflowStep,
  summaries: Map<string, StepSummary>,
  originalTask?: string,
  _agentInfo?: AgentSystemPrompt,
  completionKey?: string,
): string {
  const context = step.context ?? [];
  const depIds = context.length > 0 ? context : producersFromRefs(step);
  const parts: string[] = [];
  if (originalTask) {
    parts.push(`=== Original Request ===\n${originalTask}`);
  }
  for (const depId of depIds) {
    const s = summaries.get(depId);
    if (!s) continue;
    const partsFor: string[] = [
      `Summary: ${s.summary}`,
      `Artifact: ${s.artifact}`,
      `Files: ${s.affectedFiles.join(", ") || "(none)"}`,
    ];
    parts.push(
      `=== ${depId} ===\n` + partsFor.join("\n")
    );
  }
  if (step.task) {
    parts.push(`=== Task ===\n${step.task}`);
  }
  if (step.agent === "arch") {
    parts.push(`=== Structural Code Graph (ADR-002) ===\nYou can call the \`code_graph_query\` tool to retrieve structural call graphs, dependency graphs, or blast-radius analysis.`);
  }
  parts.push(buildResponseInstructions(step, completionKey));
  return parts.join("\n\n");
}
