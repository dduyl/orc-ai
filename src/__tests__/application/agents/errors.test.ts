import { describe, it, expect } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  AgentCallError,
  classifyAgentError,
  toQuotaInfo,
  type AgentCallErrorKind,
} from "../../../application/agents/errors.js";

describe("classifyAgentError corpus", () => {
  it.each([
    ["You exceeded your current quota, please check your plan and billing details.", "quota"],
    ["Error code: 429 - {'error': {'message': 'You exceeded your current quota', 'type': 'insufficient_quota'}}", "quota"],
    ["insufficient_quota", "quota"],
    ["RESOURCE_EXHAUSTED: the model ran out of quota", "quota"],
    ["Your account has exceeded its monthly spend limit", "quota"],
    ["You have reached the billing limit for your organization", "quota"],
    ["You've reached your daily request limit for the free tier", "quota"],
    ["Your quota usage is at 100% — no further requests allowed", "quota"],
    ["This request is larger than the model's context window and the credit balance is too low to run it", "quota"],
  ] as const)("classifies quota: %s", (msg, kind) => {
    expect(classifyAgentError(new Error(msg)).kind).toBe(kind);
  });

  it.each([
    ["Too Many Requests", "rate_limit"],
    ["429 Too Many Requests", "rate_limit"],
    ["Rate limit reached for default-gpt-4o-mini in organization org-xxx", "rate_limit"],
    ["rate_limit_exceeded", "rate_limit"],
    ["The server is temporarily unavailable", "rate_limit"],
    ["Please retry your request after 30 seconds", "rate_limit"],
    ["You are being rate limited. Please try again in 20 seconds.", "rate_limit"],
  ] as const)("classifies rate_limit: %s", (msg, kind) => {
    expect(classifyAgentError(new Error(msg)).kind).toBe(kind);
  });

  it.each([
    ["Incorrect API key provided: sk-abc123", "auth"],
    ["401 Unauthorized", "auth"],
    ["authentication_error: invalid x-api-key header", "auth"],
    ["The api_key client must be set", "auth"],
    ["Permission denied: you do not have access", "auth"],
    ["403 Forbidden", "auth"],
  ] as const)("classifies auth: %s", (msg, kind) => {
    expect(classifyAgentError(new Error(msg)).kind).toBe(kind);
  });

  it.each([
    ["connection closed before message completed", "connection"],
    ["Fetch failed: socket hang up", "connection"],
    ["connect ECONNREFUSED 127.0.0.1:443", "connection"],
    ["getaddrinfo ENOTFOUND api.openai.com", "connection"],
    ["request timed out after 60000ms", "connection"],
    ["Error: stream was reset by the server", "connection"],
  ] as const)("classifies connection: %s", (msg, kind) => {
    expect(classifyAgentError(new Error(msg)).kind).toBe(kind);
  });

  it.each([
    ["Failed to spawn ACP agent 'opencode': ENOENT", "spawn"],
    ["spawn opencode ENOENT", "spawn"],
    ["The system cannot find the file specified", "spawn"],
    ["'opencode' is not recognized as an internal or external command", "spawn"],
    ["Failed to spawn PTY for claude: EACCES", "spawn"],
  ] as const)("classifies spawn: %s", (msg, kind) => {
    expect(classifyAgentError(new Error(msg)).kind).toBe(kind);
  });

  it.each([
    "Something went wrong, please contact support",
    "Internal server error",
    "The agent returned an unexpected response",
    "gibberish that matches nothing",
  ] as const)("classifies unknown (escape hatch): %s", msg => {
    expect(classifyAgentError(msg).kind).toBe("unknown");
  });

  it("classifies a plain string input", () => {
    expect(classifyAgentError("You exceeded your current quota").kind).toBe("quota");
  });

  it("classifies an object with code/message (JSON-RPC error shape)", () => {
    const err = classifyAgentError({ code: -32000, message: "You exceeded your current quota" });
    expect(err.kind).toBe("quota");
    expect(err.message).toBe("You exceeded your current quota");
  });

  it("classifies a real SDK RequestError by its message", () => {
    const requestError = new RequestError(-32000, "You exceeded your current quota, please check your plan and billing details");
    const err = classifyAgentError(requestError);
    expect(err).toBeInstanceOf(AgentCallError);
    expect(err.kind).toBe("quota");
  });

  it("classifies by HTTP status code", () => {
    expect(classifyAgentError({ message: "something", status: 401 }).kind).toBe("auth");
    expect(classifyAgentError({ message: "something", status: 402 }).kind).toBe("quota");
    expect(classifyAgentError({ message: "something", status: 429 }).kind).toBe("rate_limit");
  });

  it("classifies by nested provider error type", () => {
    const err = classifyAgentError({
      message: "the model hit its limit",
      error: { type: "insufficient_quota", message: "You exceeded your current quota" },
    });
    expect(err.kind).toBe("quota");
    expect(err.providerCode).toBe("insufficient_quota");
  });
});

describe("classifyAgentError precedence (specific → general)", () => {
  it("quota beats 429/rate-limit when both are present", () => {
    expect(classifyAgentError("Error code: 429 quota exceeded").kind).toBe("quota");
    expect(classifyAgentError("429 You exceeded your current quota").kind).toBe("quota");
  });

  it("auth beats quota when both are present", () => {
    expect(classifyAgentError("401 invalid api key, quota could not be checked").kind).toBe("auth");
  });

  it("quota wording beats a status-403 auth guess (quota can surface under many statuses)", () => {
    expect(classifyAgentError({ message: "You exceeded your current quota", status: 403 }).kind).toBe("quota");
  });

  it("a bare 403 with no quota wording still classifies as auth", () => {
    expect(classifyAgentError({ message: "403 Forbidden", status: 403 }).kind).toBe("auth");
  });

  it("an auth-family code beats quota wording regardless of the message", () => {
    expect(classifyAgentError({ message: "quota exceeded", error: { type: "authentication_error" } }).kind).toBe("auth");
  });

  it("rate_limit beats connection when both are present", () => {
    expect(classifyAgentError("429 Too Many Requests (connection dropped)").kind).toBe("rate_limit");
  });
});

describe("classifyAgentError timing hints", () => {
  it("parses retry_after (seconds) into retryAfterMs", () => {
    const err = classifyAgentError({ message: "Rate limit reached", retry_after: 30 });
    expect(err.kind).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(30000);
  });

  it("parses the Retry-After header (seconds) into retryAfterMs", () => {
    const err = classifyAgentError({
      message: "Too Many Requests",
      response: { headers: { "retry-after": "120" } },
    });
    expect(err.kind).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(120000);
  });

  it("parses a data.reset_at epoch (seconds) into resetAtMs", () => {
    const err = classifyAgentError({
      message: "You exceeded your current quota",
      data: { reset_at: 1755600000 },
    });
    expect(err.kind).toBe("quota");
    expect(err.resetAtMs).toBe(1755600000000);
  });

  it("parses a data.reset_at epoch (ms) unchanged", () => {
    const err = classifyAgentError({
      message: "You exceeded your current quota",
      data: { reset_at: 1755600000000 },
    });
    expect(err.kind).toBe("quota");
    expect(err.resetAtMs).toBe(1755600000000);
  });

  it("parses an ISO 'resets at' prose hint into resetAtMs", () => {
    const err = classifyAgentError(
      "You exceeded your current quota, resets at 2026-08-20T00:00:00Z",
    );
    expect(err.kind).toBe("quota");
    expect(err.resetAtMs).toBe(Date.parse("2026-08-20T00:00:00Z"));
  });

  it("leaves retryAfterMs/resetAtMs unset when no hint is present", () => {
    const rate = classifyAgentError("Too Many Requests");
    expect(rate.retryAfterMs).toBeUndefined();
    const quota = classifyAgentError("You exceeded your current quota");
    expect(quota.resetAtMs).toBeUndefined();
  });

  it("bare 'retry after' with no time hint is not a rate limit", () => {
    expect(classifyAgentError("The request will be handled after an approval. Retry after we resume.").kind).toBe("unknown");
  });

  it("'retry after <time>' is a rate limit", () => {
    expect(classifyAgentError("Please retry after 60 seconds").kind).toBe("rate_limit");
  });

  it("bare 'forbidden' without an access/request/operation scope is not auth", () => {
    expect(classifyAgentError("The operation returned: forbidden").kind).toBe("unknown");
  });
});

describe("AgentCallError identity", () => {
  it("is idempotent — an already-classified error passes through unchanged", () => {
    const original = new AgentCallError("quota", "You exceeded your current quota", { resetAtMs: 1000 });
    expect(classifyAgentError(original)).toBe(original);
  });

  it("classifyAgentError is pure — same input maps to the same kind", () => {
    const msg = "You exceeded your current quota";
    expect(classifyAgentError(msg).kind).toBe(classifyAgentError(msg).kind);
    expect(classifyAgentError(msg).message).toBe(msg);
  });

  it("toQuotaInfo produces a zod-valid quota payload for quota errors", () => {
    const err = new AgentCallError("quota", "quota exceeded", { resetAtMs: 1755600000000, providerCode: "insufficient_quota" });
    const info = toQuotaInfo(err);
    expect(info.kind).toBe("quota");
    expect(info.resetAtMs).toBe(1755600000000);
    expect(info.providerCode).toBe("insufficient_quota");
    expect(info.message).toBe("quota exceeded");
  });

  it("toQuotaInfo keeps optional fields absent (not null)", () => {
    const err = new AgentCallError("quota", "quota exceeded");
    const info = toQuotaInfo(err);
    expect(info).toEqual({ kind: "quota", message: "quota exceeded" });
    expect("resetAtMs" in info).toBe(false);
  });

  it("toQuotaInfo stamps downgradedTo when a downgrade happened", () => {
    const err = new AgentCallError("quota", "quota exceeded", { resetAtMs: 1755600000000 });
    const info = toQuotaInfo(err, "gpt-4o-mini");
    expect(info.downgradedTo).toBe("gpt-4o-mini");
    expect(info.resetAtMs).toBe(1755600000000);
  });

  it("toQuotaInfo keeps downgradedTo absent when no downgrade happened", () => {
    const err = new AgentCallError("quota", "quota exceeded");
    const info = toQuotaInfo(err);
    expect("downgradedTo" in info).toBe(false);
  });

  it("serializes a stable JSON shape", () => {
    const err = new AgentCallError("rate_limit", "Too Many Requests", { retryAfterMs: 30000 });
    expect(err.toJSON()).toMatchObject({ kind: "rate_limit", message: "Too Many Requests", retryAfterMs: 30000 });
  });

  it("kind is one of the fixed union", () => {
    const err = classifyAgentError("garbage");
    const kinds: AgentCallErrorKind[] = ["quota", "rate_limit", "auth", "connection", "spawn", "unknown"];
    expect(kinds).toContain(err.kind);
  });
});