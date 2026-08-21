import type { Complexity } from "./complexity.js";
import type { ModelRoutingConfig } from "./config.js";
import type { Tier } from "./config.js";

export type { Tier } from "./config.js";

/**
 * ADR-021: roles eligible for cheap/strong model tiering. Mirrors the builtin
 * agent prompts (BUILTIN_PROMPTS in `src/adapters/mcp/handlers/content.ts`),
 * so a builtin role with no user config routes by complexity via the tiered
 * defaults. Script steps (`type: script`) bypass tiering entirely — zero LLM —
 * and are never routed here.
 */
export const BUILTIN_TIERED_ROLES: ReadonlySet<string> = new Set<string>([
  "requirement_analyst",
  "architecture_agent",
  "code_generation_backend",
  "code_generation_frontend",
  "test_generation_backend",
  "test_generation_frontend",
  "review",
]);

/**
 * Resolve the model tier for a role.
 *
 * - A role with a user config entry under `variants.<role>` (explicit user
 *   override) is tiered by complexity: "complex" -> strong, else cheap.
 * - A role in {@link BUILTIN_TIERED_ROLES} (no user override) is tiered the
 *   same way.
 * - Any other role defaults to "strong" — never under-provision an
 *   untiered role.
 */
export function resolveVariantTier(
  role: string,
  complexity: Complexity,
  config: ModelRoutingConfig = {},
): Tier {
  const tiered = Boolean(config.variants?.[role]) || BUILTIN_TIERED_ROLES.has(role);
  if (!tiered) return "strong";
  return complexity === "complex" ? "strong" : "cheap";
}
