import type { HookEvent } from "../../core/hooks.js";
import type { AcpStrategy } from "./acp/types.js";

export interface AgentStrategy {
  id: string;
  buildArgs(prompt: string, model?: string): string[];
  /**
   * ADR-021: whether this strategy can apply a concrete model via its CLI
   * flags. When absent/false, the PTY path logs the intended model and
   * proceeds with the tool default.
   */
  supportsModel?: boolean;
  keepAlive: boolean;
  isComplete(events: HookEvent[]): boolean;
  extractOutput(stdout: string): string;
}

import { opencodeStrategy } from "./strategies/opencode.js";
import { claudeStrategy } from "./strategies/claude.js";
import { antigravityStrategy } from "./strategies/antigravity.js";
import { acpOpencodeStrategy } from "./strategies/acp-opencode.js";
import { acpClaudeStrategy } from "./strategies/acp-claude.js";

const strategies = new Map<string, AgentStrategy>([
  [opencodeStrategy.id, opencodeStrategy],
  [claudeStrategy.id, claudeStrategy],
  [antigravityStrategy.id, antigravityStrategy],
]);

const acpStrategies = new Map<string, AcpStrategy>([
  [acpOpencodeStrategy.id, acpOpencodeStrategy],
  [acpClaudeStrategy.id, acpClaudeStrategy],
]);

export function getStrategy(adapterId: string): AgentStrategy {
  const s = strategies.get(adapterId);
  if (!s) throw new Error(`No strategy registered for adapter: ${adapterId}`);
  return s;
}

export function registerStrategy(strategy: AgentStrategy): void {
  strategies.set(strategy.id, strategy);
}

export function registerAcpStrategy(strategy: AcpStrategy): void {
  acpStrategies.set(strategy.id, strategy);
}

/** Registered ACP strategy for an adapter id, if any. */
export function getAcpStrategy(adapterId: string): AcpStrategy | undefined {
  return acpStrategies.get(adapterId);
}
