import { loadAgentSystemPrompts } from "../../../application/planner/prompt-loader.js";
import { BUILTIN_PROMPTS } from "./content.js";

export function getValidAgentNames(): Set<string> {
  const prompts = loadAgentSystemPrompts();
  if (prompts.size > 0) return new Set(prompts.keys());
  return new Set(BUILTIN_PROMPTS.map(a => a.name));
}