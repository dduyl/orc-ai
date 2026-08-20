/**
 * Shared ACP (Agent Client Protocol) adapter types.
 *
 * Phase 1 scope: a text+usage turn over stdio ACP, with tool permission
 * gating. Everything here is framework-agnostic so it can be unit-tested
 * without a live ACP server.
 */

import type { AgentCallError } from "../errors.js";

/** Why an ACP prompt turn stopped. Mirrors the ACP `StopReason` union. */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/** Normalized agent token usage (ACP `Usage`, flattened to a stable shape). */
export interface AgentUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

/** Result of a single ACP prompt turn. */
export interface AcpTurnResult {
  stopReason: AcpStopReason;
  content: string;
  usage: AgentUsage;
  duration: number;
  /** Set when the turn settled on an error path (e.g. cancelled mid-connect). */
  error?: AgentCallError | string;
  /**
   * ADR-022: set when the turn failed on the first prompt with a quota
   * error and succeeded after a same-session `session/set_config_option`
   * model downgrade + second prompt.
   */
  downgraded?: boolean;
  /**
   * ADR-021: set when the session model was pre-configured via
   * `session/set_config_option` after `session/new`, before the first prompt.
   * The agent's own model selection is otherwise authoritative.
   */
  configuredModel?: string;
}

/** Command + args to spawn an ACP server in stdio mode. */
export interface AcpSpawnSpec {
  command: string;
  args: string[];
}

/** Permission answers supported by the Phase 1 gate. */
export type PermissionAnswerKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

/** Auto-permission behavior driven by `ORC_ACP_PERMISSION`. */
export type AutoPermissionMode = "safe_hold" | "allow_always" | "reject_always";

/** Per-tool ACP strategy: how to spawn the agent in ACP-server mode. */
export interface AcpStrategy {
  id: string;
  /** PATH probe result captured at registration time. */
  available: boolean;
  /** Human-readable entrypoint name used in probe/error messages. */
  label: string;
  /**
   * Resolve the spawn command + args for ACP server mode in `cwd`.
   * Throws an actionable error when the entrypoint is unavailable or
   * the adapter id is misconfigured.
   */
  buildSpawn(cwd: string): AcpSpawnSpec;
}