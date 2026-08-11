import type { AgentUsage } from "./acp/types.js";

export type AgentMode = "interactive" | "headless";

export interface AgentCallResult {
  content: string;
  model: string;
  tokensUsed: number;
  duration: number;
  /** Detailed token breakdown when the call produced usage telemetry (ACP). */
  usage?: AgentUsage;
}

export interface AdapterDef {
  id: string;
  command: string;
  label: string;
}

export const BUILTIN_ADAPTERS: AdapterDef[] = [
  { id: "opencode", command: "opencode", label: "OpenCode AI Code Orchestrator" },
  { id: "claude", command: "claude", label: "Claude AI Code Assistant" },
  { id: "antigravity", command: "agy", label: "Google Antigravity Agent" },
];

export function getAdapter(id: string): AdapterDef | undefined {
  return BUILTIN_ADAPTERS.find(a => a.id === id);
}
