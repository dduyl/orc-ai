/**
 * Shared ACP (Agent Client Protocol) adapter types.
 *
 * Phase 1 scope: a text+usage turn over stdio ACP, with tool permission
 * gating. Everything here is framework-agnostic so it can be unit-tested
 * without a live ACP server.
 */

import type { AgentCallError } from "../errors.js";
import type { Tier, ProviderConfig } from "../config.js";

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
  /**
   * ADR-021 (provider failover): set when the turn failed on a prompt with a
   * quota error and succeeded after the `onProviderQuota` seam switched to a
   * different provider (`providers/list` + `providers/set`) and re-ran the
   * prompt against it. Carries the provider id now in effect.
   */
  providerFailover?: string;
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

/**
 * A provider the agent advertises via ACP `providers/list` (UNSTABLE).
 * Framework-agnostic projection of the SDK's `ProviderInfo`.
 */
export interface AcpProviderInfo {
  /** Provider identifier, e.g. "main" or "openai". */
  providerId: string;
  /** Protocol types this provider supports (e.g. "anthropic", "openai"). */
  supported: string[];
  /** Whether this provider is mandatory and cannot be disabled. */
  required: boolean;
  /** Current effective non-secret routing config (null/omitted = disabled). */
  current?: { apiType: string; baseUrl: string } | null;
}

/** Routing config applied via ACP `providers/set` (UNSTABLE). */
export interface AcpProviderConfig {
  providerId: string;
  apiType: string;
  baseUrl: string;
  headers?: Record<string, string>;
}

/**
 * ACP provider-routing surface handed to `onProviderQuota`. Both methods are
 * UNSTABLE ACP methods (`providers/list`, `providers/set`) and are only usable
 * when the agent advertises the `providers` capability at initialize time.
 */
export interface ProviderRouter {
  listProviders(): Promise<AcpProviderInfo[]>;
  setProvider(config: AcpProviderConfig): Promise<void>;
}

/** Outcome of a successful provider failover. */
export interface ProviderFailoverResult {
  /** Provider id the session now routes through. */
  providerId: string;
  /**
   * ADR-021: model re-resolved for the new provider (the failover re-runs
   * `pickVariantModel` against the post-switch routing intent). Applied via
   * `session/set_config_option` before the retry prompt; when absent or
   * rejected, the agent default is used.
   */
  model?: string;
}

/** Context passed to `onProviderQuota` for the failover decision. */
export interface ProviderFailoverContext {
  /** Models the agent advertised at `session/new` (pre-switch). */
  advertised: string[];
  /** ADR-021 tier in effect for this turn. */
  tier?: Tier;
  /** ADR-021 concrete variant model in effect (user override). */
  variantModel?: string;
  /**
   * ADR-021 (M4): the routing config's full `providers` block, keyed by
   * provider id. A seam can build a `providers/set { apiType, baseUrl,
   * headers }` payload purely from the context without re-reading config.
   * Absent when the harness didn't supply a providers block.
   */
  providers?: ProviderConfig;
}

/**
 * ADR-021 provider failover seam, mirror of the harness's
 * `resolveDowngradeModel` but ACP-only. Consulted when a prompt hits a quota
 * error and the agent advertises the `providers` capability. Returning a
 * failover result switches the session to the given provider and re-runs the
 * prompt on it (re-entering the step's loop without consuming a retry slot);
 * returning `undefined` (or throwing) leaves the quota error to the
 * downgrade/pause ladder.
 */
export type OnProviderQuota = (
  router: ProviderRouter,
  context: ProviderFailoverContext,
) => Promise<ProviderFailoverResult | undefined>;

/**
 * ADR-021 Phase F: a token-paid fallback request. Built by the harness after a
 * quota error when the agent advertised an env-var auth method AND a
 * `tokenPaidApiKey` is configured (per-provider wins over top-level). The key
 * is injected into the child process environment at `envVarName` and the agent
 * is asked to authenticate via ACP `authenticate` before a single prompt run.
 */
export interface TokenPaidRequest {
  /** The ACP auth method id (the agent's `AuthMethodEnvVar.id`). */
  methodId: string;
  /** The environment variable name the agent reads the key from. */
  envVarName: string;
  /** The pay-as-you-go API key. NEVER log this value. */
  key: string;
}