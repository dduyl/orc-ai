import type { HookEvent } from "../../core/hooks.js";

export interface AgentStrategy {
  id: string;
  buildArgs(prompt: string): string[];
  keepAlive: boolean;
  isComplete(events: HookEvent[]): boolean;
  extractOutput(stdout: string): string;
}

import { opencodeStrategy } from "./strategies/opencode.js";
import { claudeStrategy } from "./strategies/claude.js";

const strategies = new Map<string, AgentStrategy>([
  [opencodeStrategy.id, opencodeStrategy],
  [claudeStrategy.id, claudeStrategy],
]);

export function getStrategy(adapterId: string): AgentStrategy {
  const s = strategies.get(adapterId);
  if (!s) throw new Error(`No strategy registered for adapter: ${adapterId}`);
  return s;
}

export function registerStrategy(strategy: AgentStrategy): void {
  strategies.set(strategy.id, strategy);
}
