import type { Complexity } from "./complexity.js";
import type { ModelRoutingConfig } from "./config.js";
import type { Tier } from "./config.js";

export type { Tier } from "./config.js";

/**
 * ADR-021: roles eligible for cheap/strong model tiering. Empty until Phase G
 * wires the builtin roles (script steps bypass tiering entirely — zero LLM).
 * While empty, only an explicit `variants.<role>` entry in the user config
 * routes a role by complexity.
 */
export const BUILTIN_TIERED_ROLES: ReadonlySet<string> = new Set<string>();

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
