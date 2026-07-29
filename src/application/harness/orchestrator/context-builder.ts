import type { AgentSystemPrompt } from "../../planner/prompt-loader.js";
import type { WorkflowStep } from "../../../core/schemas.js";
import type { StepSummary } from "./types.js";

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
