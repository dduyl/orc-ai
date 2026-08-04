/**
 * Pure validation for `create_workflow` step definitions. Kept free of heavy
 * imports (registry/Tracker/sqlite) so it is directly unit-testable.
 *
 * Returns an error message string, or null when the steps are structurally
 * acceptable (the full zod schema still runs afterwards in the handler).
 */
export function validateCreateWorkflowSteps(
  steps: any[],
  validAgents: ReadonlySet<string>,
): string | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] ?? {};
    const id = typeof s.id === "string" && s.id.length > 0 ? s.id : `#${i + 1}`;

    if (s.type === "script") {
      if (typeof s.run !== "string" || s.run.trim() === "") {
        return `Step "${id}": script step requires a non-empty 'run' expression (cmd "..." or exec "...")`;
      }
      if (!Array.isArray(s.emits) || s.emits.length !== 2) {
        return `Step "${id}": script step must define exactly 2 'emits' (positional pass/fail signals)`;
      }
      continue;
    }

    if (!s.agent || typeof s.agent !== "string") {
      return `Step "${id}": "agent" field is required (or use type="script" with a 'run' expression)`;
    }
    if (!validAgents.has(s.agent)) {
      return `Step "${id}": unknown agent "${s.agent}". Use list_prompts to see valid names.`;
    }
  }
  return null;
}
