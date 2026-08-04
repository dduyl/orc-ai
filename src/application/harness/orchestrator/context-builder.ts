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
  const sig = step.signal;
  if (sig) {
    instructions.push(`- signal: boolean — ${sig.description} (true = satisfactory → continue, false = needs rework → retry upstream)`);
  }
  return instructions.join("\n");
}

export function buildStepContext(
  step: WorkflowStep,
  summaries: Map<string, StepSummary>,
  originalTask?: string,
  _agentInfo?: AgentSystemPrompt,
  completionKey?: string,
): string {
  const context = step.context ?? [];
  const depIds = context.length > 0 ? context : step.depends_on;
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
  parts.push(buildResponseInstructions(step, completionKey));
  return parts.join("\n\n");
}
