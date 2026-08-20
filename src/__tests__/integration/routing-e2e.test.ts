import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createStepHandler } from "../../application/harness/orchestrator/step-handler.js";
import type { RunContext } from "../../application/harness/execution/step-runner.js";
import type { WorkflowStep } from "../../core/schemas.js";
import { StreamEmitter } from "../../adapters/stream/emitter.js";
import { log } from "../../core/log.js";
import { BUILTIN_TIERED_ROLES } from "../../application/agents/variants.js";
import type { OnProviderQuota, TokenPaidRequest } from "../../application/agents/acp/types.js";
import type { AdapterDef } from "../../application/agents/adapter.js";
import type { Tier } from "../../application/agents/config.js";
import type { MockAcpState } from "../helpers/acp-runner.js";
import { tmpLogPath } from "../helpers/acp-mock-server.js";

/**
 * Phase G routing e2e: drives the real harness (createStepHandler) with a real
 * ACP session (the shared stdio mock agent server) so the whole ADR-021/022
 * chain is exercised end-to-end: quota -> provider failover -> downgrade ->
 * token-paid -> pause -> auto-resume.
 */
const acpState = vi.hoisted<MockAcpState>(() => ({
  env: {},
  records: { calls: 0, variantTiers: [], variantModels: [] },
}));

vi.mock("../../application/agents/adapter-pty.js", async () => {
  const { mockAcpStream } = await import("../helpers/acp-runner.js");
  return {
    callAgentStream: (
      adapter: AdapterDef,
      prompt: string,
      _hook?: string,
      downgradeTo?: string,
      variantTier?: Tier,
      variantModel?: string,
      configuredProviders?: string[],
      onProviderQuota?: OnProviderQuota,
      tokenPaid?: TokenPaidRequest,
    ) =>
      mockAcpStream(
        acpState,
        adapter,
        prompt,
        downgradeTo,
        variantTier,
        variantModel,
        configuredProviders,
        onProviderQuota,
        tokenPaid,
      ),
  };
});

const QUOTA_MSG = "You exceeded your current quota, resets at 1755600000000";
const RESET_MS = 1755600000000;
const PROVIDER_B_KEY = "sk-provider-b-secret";
const MOCK_ENV_LOG = {
  MOCK_MODE: "quota-failover",
  MOCK_SECOND: "quota",
  MOCK_PROVIDER_CAP: "1",
  MOCK_PROVIDERS: JSON.stringify([
    { providerId: "provider-a", supported: ["anthropic"], required: false, current: { apiType: "anthropic", baseUrl: "https://api.anthropic.com" } },
    { providerId: "provider-b", supported: ["openai"], required: false, current: null },
  ]),
  MOCK_AUTH_METHODS: "1",
  MOCK_MODEL_CFG: "1",
  MOCK_MODEL_ADVERTISED: "mock-cheap,mock-strong-a",
  MOCK_QUOTA_MSG: QUOTA_MSG,
  MOCK_EXPECTED_KEY: PROVIDER_B_KEY,
} as const;

const sig = (name: string): { name: string; description: string } => ({ name, description: name });

const agentStep = (): WorkflowStep => ({
  id: "code",
  type: "agent",
  agent: "codegen",
  emits: [sig("sig_done")],
  on: ["__start__"],
  context: [],
});

function ctx(): RunContext {
  return {
    workflowId: "wf1",
    stepResults: new Map(),
    buildResults: new Map(),
    maxRetries: 1,
    repairFeedbacks: new Map(),
  };
}

function readLog(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
}

/** ADR-021 provider-failover seam: switch to the first non-current provider. */
function failoverSeam(): OnProviderQuota {
  return async router => {
    const providers = await router.listProviders();
    const current = providers.find(p => p.current)?.providerId;
    const target = providers.find(p => p.providerId !== current)?.providerId ?? providers[0]?.providerId;
    if (!target) return undefined;
    await router.setProvider({ providerId: target, apiType: "openai", baseUrl: "https://api.openai.com/v1" });
    return { providerId: target, model: "mock-cheap" };
  };
}

let tmpRoot = "";
const tmpLogs: string[] = [];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orc-routing-e2e-"));
  tmpLogs.length = 0;
  acpState.env = {};
  acpState.records.calls = 0;
  acpState.records.variantTiers = [];
  acpState.records.variantModels = [];
  process.env.ORC_ACP_PERMISSION = "allow_always";
});

afterEach(() => {
  delete process.env.ORC_ACP_PERMISSION;
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  for (const f of tmpLogs) {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

describe("routing e2e: full ADR-021/022 quota ladder", () => {
  it("quota -> provider failover -> downgrade -> token-paid -> pause, then auto-resume on resetAtMs", async () => {
    const cfgLog = tmpLogPath("routing-cfg");
    const providerLog = tmpLogPath("routing-provider");
    const authLog = tmpLogPath("routing-auth");
    tmpLogs.push(cfgLog, providerLog, authLog);

    acpState.env = {
      ...MOCK_ENV_LOG,
      MOCK_CFG_LOG: cfgLog,
      MOCK_PROVIDER_LOG: providerLog,
      MOCK_AUTH_LOG: authLog,
    };

    const handler = createStepHandler({
      adapter: { id: "codegen", command: "node", label: "Codegen" },
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: new StreamEmitter(),
      task: "build the feature",
      // Non-repo root -> complexity "complex"; the injected resolver pins "cheap".
      projectRoot: tmpRoot,
      modelRoutingConfig: {
        variants: { codegen: { cheap: "mock-cheap" } },
        providers: {
          "provider-a": { tokenPaidApiKey: "sk-provider-a" },
          "provider-b": { tokenPaidApiKey: PROVIDER_B_KEY },
        },
        tokenPaidApiKey: "sk-top-level",
      },
      resolveVariantTier: () => "cheap",
      resolveDowngradeModel: () => "mock-downgrade",
      onProviderQuota: failoverSeam(),
    });

    const out = await handler(agentStep(), ctx());

    expect(out.status).toBe("paused");
    expect(out.failureReason).toBe("quota_exhausted");
    expect(out.downgradedTo).toBe("mock-downgrade");
    expect(out.quota).toEqual({
      kind: "quota",
      resetAtMs: RESET_MS,
      message: QUOTA_MSG,
      downgradedTo: "mock-downgrade",
    });

    // Every ladder rung reached the agent with the harness-chosen model.
    expect(acpState.records.calls).toBe(3);
    expect(acpState.records.variantTiers).toEqual(["cheap", "cheap", "cheap"]);
    expect(acpState.records.variantModels).toEqual(["mock-cheap", "mock-cheap", "mock-cheap"]);

    // Provider failover happened before the downgrade retry (calls 1 and 2).
    const providerSets = readLog(providerLog);
    expect(providerSets.length).toBeGreaterThanOrEqual(2);
    for (const entry of providerSets) {
      expect((entry as { providerId?: string }).providerId).toBe("provider-b");
    }

    // The mock pre-configures "mock-cheap" on every session, including after
    // each failover re-resolves the model.
    const cfgEntries = readLog(cfgLog);
    expect(cfgEntries.length).toBeGreaterThanOrEqual(3);
    for (const entry of cfgEntries) {
      expect((entry as { value?: string }).value).toBe("mock-cheap");
    }

    // Exactly one token-paid authenticate; the per-provider key reached the
    // child (keyMatches) and was injected (keyInjected), without ever leaking.
    const authEntries = readLog(authLog);
    expect(authEntries).toHaveLength(1);
    expect(authEntries[0]).toMatchObject({
      methodId: "env-var",
      keyInjected: true,
      keyMatches: true,
    });

    // The tokenPaidApiKey must never appear in any log line (re-run the ladder
    // while a log subscription is attached, capturing every message).
    const logged: string[] = [];
    const unsub = log.subscribe(e => logged.push(e.message));
    try {
      acpState.records.calls = 0;
      acpState.records.variantTiers = [];
      acpState.records.variantModels = [];
      const rerun = await handler(agentStep(), ctx());
      expect(rerun.status).toBe("paused");
    } finally {
      unsub();
    }
    expect(logged.some(m => m.includes(PROVIDER_B_KEY))).toBe(false);

    // Auto-resume: the wake timer re-dispatches the step on a fresh handler
    // invocation once the quota window passes (stream mode -> completes).
    acpState.records.calls = 0;
    acpState.records.variantTiers = [];
    acpState.records.variantModels = [];
    const resumeCfg = tmpLogPath("routing-resume-cfg");
    tmpLogs.push(resumeCfg);
    acpState.env = {
      MOCK_MODE: "stream",
      MOCK_MODEL_CFG: "1",
      MOCK_MODEL_ADVERTISED: "mock-cheap,mock-strong-a",
      MOCK_CFG_LOG: resumeCfg,
    };

    const resumed = await handler(agentStep(), ctx());
    expect(resumed.status).toBe("completed");
    expect(acpState.records.calls).toBe(1);
    expect(acpState.records.variantTiers).toEqual(["cheap"]);
    const resumeCfgEntries = readLog(resumeCfg);
    expect(resumeCfgEntries.length).toBeGreaterThanOrEqual(1);
    expect((resumeCfgEntries[0] as { value?: string }).value).toBe("mock-cheap");
  });
});

describe("routing e2e: builtin tier defaults", () => {
  it("a builtin tiered role routes to strong with zero user config, via the real resolver", async () => {
    expect(BUILTIN_TIERED_ROLES.has("architecture_agent")).toBe(true);

    const handler = createStepHandler({
      adapter: { id: "architecture_agent", command: "node", label: "Architecture Agent" },
      agentPrompts: new Map([["architecture_agent", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: new StreamEmitter(),
      task: "design the system",
      // No user config, non-repo root -> real classifyComplexity -> "complex" -> strong.
      projectRoot: tmpRoot,
      modelRoutingConfig: {},
    });
    acpState.env = { MOCK_MODE: "stream" };

    const out = await handler(agentStepWithRole("architecture_agent"), ctx());

    expect(out.status).toBe("completed");
    expect(acpState.records.calls).toBe(1);
    expect(acpState.records.variantTiers[0]).toBe("strong");
    expect(acpState.records.variantModels[0]).toBeUndefined();
  });
});

function agentStepWithRole(agent: string): WorkflowStep {
  return {
    id: "code",
    type: "agent",
    agent,
    emits: [sig("sig_done")],
    on: ["__start__"],
    context: [],
  };
}