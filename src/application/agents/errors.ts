import { z } from "zod";

/**
 * Failure kinds for agent calls (ADR-022). This enumerates the possible kinds
 * — it is NOT the classifier's check order (see {@link classifyAgentError}):
 * explicit auth signals (401 / auth-family codes) always win, then quota
 * wording, then softer auth wording / 403, then rate-limit, connection, spawn,
 * unknown.
 */
export const AGENT_CALL_ERROR_KINDS = [
  "quota",
  "rate_limit",
  "auth",
  "connection",
  "spawn",
  "unknown",
] as const;

export type AgentCallErrorKind = (typeof AGENT_CALL_ERROR_KINDS)[number];

/**
 * ADR-021 Phase F: an env-var auth method the agent advertised at `initialize`
 * (`AuthMethodEnvVar`), carried back to the harness on a quota error so it can
 * decide whether a token-paid retry is possible.
 */
export interface EnvAuthMethodInfo {
  /** The ACP auth method id (`AuthMethodEnvVar.id`). */
  methodId: string;
  /** The environment variable name the agent reads the key from (`AuthEnvVar.name`). */
  envVarName: string;
}

/**
 * Zod-validated quota payload. Boundaries validate against this schema so a
 * quota value that arrives downstream is proven valid (kind, positive
 * `resetAtMs`, message), not just present.
 */
export const QuotaInfo = z.object({
  kind: z.literal("quota"),
  resetAtMs: z.number().int().positive().optional(),
  providerCode: z.string().optional(),
  message: z.string(),
  /**
   * ADR-022: model the failed step was downgraded to when a
   * quota-triggered downgrade was attempted (failed its retry too).
   */
  downgradedTo: z.string().optional(),
});
export type QuotaInfo = z.infer<typeof QuotaInfo>;

/**
 * A typed agent-call failure that survives the whole adapter → harness chain
 * (ADR-022). Downstream logic (backoff, downgrade, pause, surfacing)
 * branches on `kind` and never re-parses provider message strings.
 */
export class AgentCallError extends Error {
  readonly kind: AgentCallErrorKind;
  /** Provider-announced retry delay for rate limits, in ms. */
  readonly retryAfterMs?: number;
  /** Provider error code when one is surfaced (e.g. "insufficient_quota"). */
  readonly providerCode?: string;
  /** Provider-announced quota window reset, ms epoch. */
  readonly resetAtMs?: number;
  /**
   * ADR-021 Phase F: env-var auth methods the agent advertised at initialize,
   * attached by the ACP client to the quota errors it surfaces. Absent (or
   * empty) means no token-paid retry is possible.
   */
  readonly authMethods?: EnvAuthMethodInfo[];
  /**
   * ADR-021 Phase F: the provider id now in effect when the quota was raised
   * (set after a successful provider failover). Used by the harness to pick a
   * per-provider `tokenPaidApiKey`; absent when no failover occurred (the
   * top-level key applies).
   */
  readonly providerId?: string;

  constructor(
    kind: AgentCallErrorKind,
    message: string,
    opts: {
      retryAfterMs?: number;
      providerCode?: string;
      resetAtMs?: number;
      authMethods?: EnvAuthMethodInfo[];
      providerId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AgentCallError";
    this.kind = kind;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.providerCode !== undefined) this.providerCode = opts.providerCode;
    if (opts.resetAtMs !== undefined) this.resetAtMs = opts.resetAtMs;
    if (opts.authMethods !== undefined) this.authMethods = opts.authMethods;
    if (opts.providerId !== undefined) this.providerId = opts.providerId;
  }

  /** Stable serialization for the data-flow validity assertions. */
  toJSON(): {
    name: string;
    kind: AgentCallErrorKind;
    message: string;
    retryAfterMs?: number;
    providerCode?: string;
    resetAtMs?: number;
    authMethods?: EnvAuthMethodInfo[];
    providerId?: string;
  } {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.providerCode !== undefined ? { providerCode: this.providerCode } : {}),
      ...(this.resetAtMs !== undefined ? { resetAtMs: this.resetAtMs } : {}),
      ...(this.authMethods !== undefined ? { authMethods: this.authMethods } : {}),
      ...(this.providerId !== undefined ? { providerId: this.providerId } : {}),
    };
  }
}

/**
 * Serializes to a stable shape for the data-flow validity assertions.
 * `downgradedTo` (optional) stamps the quota payload with the model the failed
 * step was downgraded to, mirroring `QuotaInfo.downgradedTo`.
 */
export function toQuotaInfo(err: AgentCallError, downgradedTo?: string): QuotaInfo {
  return QuotaInfo.parse({
    kind: err.kind,
    message: err.message,
    ...(err.resetAtMs !== undefined ? { resetAtMs: err.resetAtMs } : {}),
    ...(err.providerCode !== undefined ? { providerCode: err.providerCode } : {}),
    ...(downgradedTo !== undefined && downgradedTo !== "" ? { downgradedTo } : {}),
  });
}

function toRecord(err: unknown): Record<string, unknown> {
  return err !== null && typeof err === "object" ? (err as Record<string, unknown>) : {};
}

function extractMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || "unknown agent call error";
  const rec = toRecord(err);
  if (typeof rec.message === "string" && rec.message !== "") return rec.message;
  const inner = rec.error;
  if (inner !== null && typeof inner === "object") {
    const innerMsg = (inner as Record<string, unknown>).message;
    if (typeof innerMsg === "string" && innerMsg !== "") return innerMsg;
  }
  const data = rec.data;
  if (data !== null && typeof data === "object") {
    const dataMsg = (data as Record<string, unknown>).message;
    if (typeof dataMsg === "string" && dataMsg !== "") return dataMsg;
  }
  return String(err ?? "unknown agent call error");
}

function extractCode(err: unknown): string | number | undefined {
  const rec = toRecord(err);
  const code = rec.code;
  if (typeof code === "string" || typeof code === "number") return code;
  if (err instanceof Error) {
    const c = (err as unknown as Record<string, unknown>).code;
    if (typeof c === "string" || typeof c === "number") return c;
  }
  return undefined;
}

function extractStatus(err: unknown): number | undefined {
  const rec = toRecord(err);
  if (typeof rec.status === "number") return rec.status;
  const response = rec.response;
  if (response !== null && typeof response === "object") {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function extractProviderCode(err: unknown): string | undefined {
  const code = extractCode(err);
  if (typeof code === "string" && code !== "") return code;
  // Some providers nest the machine-readable type: `{ error: { type } }`.
  const rec = toRecord(err);
  const inner = rec.error;
  if (inner !== null && typeof inner === "object") {
    const type = (inner as Record<string, unknown>).type;
    if (typeof type === "string" && type !== "") return type;
  }
  return undefined;
}

/** Parse an epoch hint that may be seconds or ms, or an ISO/date string. */
function parseEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num < 1e12 ? num * 1000 : num;
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function extractRetryAfterMs(err: unknown): number | undefined {
  const rec = toRecord(err);
  const direct = rec.retry_after ?? rec.retryAfter;
  const fromDirect = parseEpochMs(direct);
  if (fromDirect !== undefined) return fromDirect;
  const data = rec.data;
  if (data !== null && typeof data === "object") {
    const fromData = parseEpochMs((data as Record<string, unknown>).retry_after);
    if (fromData !== undefined) return fromData;
  }
  const response = rec.response;
  if (response !== null && typeof response === "object") {
    const headers = (response as Record<string, unknown>).headers;
    if (headers !== null && typeof headers === "object") {
      const headerRec = headers as Record<string, unknown>;
      const header = headerRec["retry-after"] ?? headerRec["Retry-After"];
      if (typeof header === "string" && header.trim() !== "") {
        const fromHeader = parseEpochMs(header.trim());
        if (fromHeader !== undefined) return fromHeader;
      }
    }
  }
  return undefined;
}

function extractResetAtMs(err: unknown, message: string): number | undefined {
  const rec = toRecord(err);
  const direct = rec.reset_at ?? rec.resetAt;
  const fromDirect = parseEpochMs(direct);
  if (fromDirect !== undefined) return fromDirect;
  const data = rec.data;
  if (data !== null && typeof data === "object") {
    const fromData = parseEpochMs((data as Record<string, unknown>).reset_at);
    if (fromData !== undefined) return fromData;
  }
  // Provider-announced window in prose: "... resets at <time> ...".
  const prose = message.match(/resets?\s+at\s+([^.,;)]+)/i);
  if (prose) {
    const fromProse = parseEpochMs(prose[1].trim());
    if (fromProse !== undefined) return fromProse;
  }
  return undefined;
}

const AUTH_PATTERNS = [
  /\binvalid\s+api\s+key\b/i,
  /\bincorrect\s+api\s+key\b/i,
  /\bapi\s*[_-]?key\b/i,
  /\bapi\s+key\s+invalid\b/i,
  /\bauthentication\s+failed\b/i,
  /\bauthentication\s+error\b/i,
  /\bauthentication[_-]error\b/i,
  /\bunauthenticated\b/i,
  /\bunauthorized\b/i,
  /\bpermission\s+denied\b/i,
  // Bare "forbidden" is too broad — require an access/request/operation scope
  // so a quota or other message that merely contains the word stays quota.
  /(access|request|operation)\s+forbidden/i,
  /\b401\b/,
  /\b403\b/,
];

const QUOTA_PATTERNS = [
  /\binsufficient_quota\b/i,
  /\bresource_exhausted\b/i,
  /you\s+exceeded\s+your\s+current\s+quota/i,
  /\bquota\b[^.]{0,60}(exceeded|limit|usage)/i,
  /\bmonthly\s+spend\b/i,
  /\bbilling\s+limit\b/i,
  /\bdaily\s+request\s+limit\b/i,
  // Anthropic: "…the credit balance is too low to run it" (surfaces as a 429 +
  // rate_limit_error, so the wording check must beat the rate-limit branch).
  /credit\s+balance\s+is\s+too\s+low/i,
];

const RATE_LIMIT_PATTERNS = [
  // "retry after" only counts when a time hint follows — a vague "retry after
  // approval" is not a rate limit. (The structural retry_after/Retry-After
  // fields are handled by extractRetryAfterMs regardless of wording.)
  /\bretry\s+after\s+\d+\s*(?:seconds?|minutes?|hours?|ms|milliseconds?)?/i,
  /\btoo\s+many\s+requests\b/i,
  /\brate\s+limit\b/i,
  /\brate_limit/i,
  /\btemporarily\s+unavailable\b/i,
  /\b429\b/,
];

const CONNECTION_PATTERNS = [
  /\bconnection\s+closed\b/i,
  /\bconnection\s+reset\b/i,
  /\bconnection\s+refused\b/i,
  /\beconnrefused\b/i,
  /\beconnreset\b/i,
  /\beaddrnotavail\b/i,
  /\benetunreach\b/i,
  /\bgetaddrinfo\b/i,
  /\bstream\s+was\s+reset\b/i,
  /\bsocket\s+(hang|closed)\b/i,
  /\bnetwork\s+error\b/i,
  /\bnetwork\s+is\s+unreachable\b/i,
  /\bfetch\s+failed\b/i,
  /\bundici\b/i,
  /\bconnect\s+failed\b/i,
  /\btimeout\b/i,
  /\btimed\s+out\b/i,
];

const SPAWN_PATTERNS = [
  /failed\s+to\s+spawn/i,
  /\benoent\b/i,
  /\beacces\b/i,
  /command\s+not\s+found/i,
  /not\s+recognized/i,
  /no\s+such\s+file\b/i,
  /exited\s+before/i,
  /the\s+system\s+cannot\s+find\s+the\s+file/i,
];

/** "try again"/"retry" only counts as a rate-limit signal when paired with a time hint. */
function hasTryAgainWithTime(message: string): boolean {
  return (
    /\b(try\s+again|retry)\b/i.test(message) &&
    /\b(in|within|after)\s+(\d+)\s*(seconds?|minutes?|hours?|ms|milliseconds?)\b/i.test(message)
  );
}

function matchAuth(message: string, status: number | undefined, code: string | undefined): boolean {
  if (status === 401 || status === 403) return true;
  return AUTH_PATTERNS.some(re => re.test(message));
}

/**
 * Explicit auth signals that always win regardless of message wording. A 401
 * status or an auth-family error code is unambiguous — it stays `auth` even
 * when the message also mentions quota/rate-limit phrasing.
 */
function hardAuth(status: number | undefined, code: string | undefined): boolean {
  if (status === 401) return true;
  return code === "invalid_api_key" || code === "authentication_error" || code === "permission_error";
}

function matchQuota(message: string, status: number | undefined, code: string | undefined): boolean {
  if (status === 402) return true;
  if (code === "insufficient_quota" || code === "billing_not_active") return true;
  return QUOTA_PATTERNS.some(re => re.test(message));
}

function matchRateLimit(message: string, status: number | undefined, code: string | undefined): boolean {
  if (status === 429) return true;
  if (code === "rate_limit_exceeded" || code === "rate_limit") return true;
  return RATE_LIMIT_PATTERNS.some(re => re.test(message));
}

/**
 * Classify an agent-call failure into a typed {@link AgentCallError}. Pure:
 * same input → same kind, no I/O, no state. The **only** place provider
 * message strings are matched (ADR-022).
 *
 * Check order:
 *  1. explicit auth — a 401 status or an auth-family error code always wins,
 *     even if the message also carries quota/rate-limit wording;
 *  2. quota wording — an exhausted quota can surface under many HTTP statuses,
 *     so its message beats the status-403 auth guess;
 *  3. softer auth — auth wording or a bare 401/403 status;
 *  4. rate-limit, connection, spawn;
 *  5. `unknown` — the escape hatch, the classifier never guesses.
 */
export function classifyAgentError(err: unknown): AgentCallError {
  if (err instanceof AgentCallError) return err;
  const message = extractMessage(err);
  const status = extractStatus(err);
  const providerCode = extractProviderCode(err);

  if (hardAuth(status, providerCode)) {
    return new AgentCallError("auth", message, { providerCode });
  }
  if (matchQuota(message, status, providerCode)) {
    return new AgentCallError("quota", message, { providerCode, resetAtMs: extractResetAtMs(err, message) });
  }
  if (matchAuth(message, status, providerCode)) {
    return new AgentCallError("auth", message, { providerCode });
  }
  if (matchRateLimit(message, status, providerCode) || hasTryAgainWithTime(message)) {
    return new AgentCallError("rate_limit", message, { providerCode, retryAfterMs: extractRetryAfterMs(err) });
  }
  if (CONNECTION_PATTERNS.some(re => re.test(message))) {
    return new AgentCallError("connection", message, { providerCode });
  }
  if (SPAWN_PATTERNS.some(re => re.test(message))) {
    return new AgentCallError("spawn", message, { providerCode });
  }
  return new AgentCallError("unknown", message, { providerCode });
}