import type { RunReport } from "./orchestrator/index.js";

/**
 * Formats the [ORC] completion prompt that the run lifecycle in
 * `./start-run.ts` pushes into the main PTY on run completion/failure
 * (GUI/embedded topology). It is NOT returned by get_run_status, which
 * returns raw tracker JSON.
 *
 * Application-layer pure formatting (no adapter imports) so the shared
 * run lifecycle in `./start-run.ts` can use it.
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