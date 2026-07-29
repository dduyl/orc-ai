import type { RunReport } from "../../../application/harness/orchestrator/index.js";
import { loadAgentSystemPrompts } from "../../../application/planner/prompt-loader.js";
import { BUILTIN_PROMPTS } from "./content.js";

export function getValidAgentNames(): Set<string> {
  const prompts = loadAgentSystemPrompts();
  if (prompts.size > 0) return new Set(prompts.keys());
  return new Set(BUILTIN_PROMPTS.map(a => a.name));
}

export function buildResultPayload(runId: string, workflowId: string, workflowName: string, report: RunReport) {
  return {
    runId,
    workflowId,
    workflowName,
    status: report.failed > 0 ? "failed" : "completed",
    report,
  };
}

/**
 * Formats the [ORC] completion notification that gets pushed into the
 * opencode PTY (or returned by get_run_status in headless mode).
 */
export function buildCompletionPrompt(runId: string, workflowName: string, report: RunReport): string {
  const overallStatus = report.failed > 0 ? "FAILED" : "COMPLETED";
  const lines: string[] = [
    `[ORC] Workflow "${workflowName}" ${overallStatus} (runId: ${runId})`,
    `Status: ${report.completed}/${report.totalSteps} steps completed`,
    "",
    "=== Step Results ===",
    "",
  ];

  for (const o of report.outcomes) {
    lines.push(`[${o.stepId}] — ${o.status.toUpperCase()}`);
    if (o.summary) lines.push(`  Summary  : ${o.summary}`);
    if (o.artifact) lines.push(`  Artifact : ${o.artifact}`);
    if (o.affectedFiles?.length) lines.push(`  Files    : ${o.affectedFiles.join(", ")}`);
    if (o.error) lines.push(`  Error    : ${o.error}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("Goal check: Review the step results above.");
  lines.push("  • If the goal is met      → call orc_return_result with your summary.");
  lines.push("  • If the goal is NOT met  → call run_workflow with the remaining task.");

  return lines.join("\n");
}
