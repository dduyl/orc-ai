import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn } from "node:child_process";
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
import { tmpLogPath, spawnAcpSpec } from "../helpers/acp-mock-server.js";

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
const TOP_LEVEL_KEY = "sk-top-level";
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

/**
 * ADR-021 provider-failover seam (FN1 fix): fail over at most once per step.
 * After the single switch the seam declines, so the client falls through to the
 * downgrade rung and the downgraded prompt ACTUALLY runs — the cfg log then
 * records `mock-downgrade` instead of never executing it (the pre-fix ladder
 * re-failovered on every quota and the downgrade retry was never reached).
 */
function failoverOnceSeam(): { seam: OnProviderQuota; switches: number } {
  let switches = 0;
  const seam: OnProviderQuota = async router => {
    if (switches > 0) return undefined;
    switches++;
    const providers = await router.listProviders();
    const current = providers.find(p => p.current)?.providerId;
    const target = providers.find(p => p.providerId !== current)?.providerId ?? providers[0]?.providerId;
    if (!target) return undefined;
    await router.setProvider({ providerId: target, apiType: "openai", baseUrl: "https://api.openai.com/v1" });
    return { providerId: target, model: "mock-cheap" };
  };
  return { seam, switches };
}

/** Drive a raw stdio session against the shared mock ACP server. */
async function rawMockSession(env: Record<string, string>) {
  const spec = spawnAcpSpec();
  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: Array<{ id?: number; method?: string; result?: { providers?: Array<Record<string, unknown>> } }> = [];
  readline.createInterface({ input: child.stdout }).on("line", l => {
    if (l.trim()) messages.push(JSON.parse(l));
  });
  const waitFor = (id: number) =>
    new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (messages.some(m => m.id === id)) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });
  const call = (id: number, method: string, params?: Record<string, unknown>) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    return waitFor(id);
  };
  const list = (id: number) =>
    (messages.find(m => m.id === id)?.result?.providers ?? []).map(p => ({
      providerId: p.providerId as string,
      current: Boolean(p.current),
    }));
  return { child, call, list };
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
      // After the downgrade rung no provider is in effect, so the token-paid
      // rung uses the top-level key (per-provider key routing is covered in
      // step-handler.test.ts).
      MOCK_EXPECTED_KEY: TOP_LEVEL_KEY,
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
        tokenPaidApiKey: TOP_LEVEL_KEY,
      },
      resolveVariantTier: () => "cheap",
      resolveDowngradeModel: () => "mock-downgrade",
      onProviderQuota: failoverOnceSeam().seam,
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

    // The single failover switch happens on rung 1; the downgrade rung declines
    // the seam so the downgraded prompt really runs (FN1).
    const providerSets = readLog(providerLog);
    expect(providerSets.length).toBeGreaterThanOrEqual(1);
    for (const entry of providerSets) {
      expect((entry as { providerId?: string }).providerId).toBe("provider-b");
    }

    // The mock pre-configures "mock-cheap" on every session (including after
    // each failover re-resolves the model), and the downgrade rung must have
    // executed a REAL downgraded prompt — the cfg log must contain
    // `mock-downgrade`. Pre-fix the re-failover seam meant that prompt never
    // ran (FN1) and the log was all `mock-cheap`.
    const cfgEntries = readLog(cfgLog);
    const cfgValues = cfgEntries.map(e => (e as { value?: string }).value);
    expect(cfgValues.length).toBeGreaterThanOrEqual(4);
    expect(cfgValues.filter(v => v === "mock-cheap").length).toBeGreaterThanOrEqual(3);
    expect(cfgValues).toContain("mock-downgrade");

    // Exactly one token-paid authenticate; the top-level key reached the child
    // (keyMatches) and was injected (keyInjected), without ever leaking.
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
    expect(logged.some(m => m.includes(TOP_LEVEL_KEY))).toBe(false);

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

describe("routing e2e: successful provider failover retry", () => {
  it("failover lands on provider-c, the retried prompt succeeds, and the step completes with providerFailover surfaced", async () => {
    const providerLog = tmpLogPath("routing-fo-provider");
    tmpLogs.push(providerLog);
    acpState.env = {
      MOCK_MODE: "quota-failover",
      MOCK_SECOND: "stream",
      MOCK_PROVIDER_CAP: "1",
      MOCK_PROVIDERS: JSON.stringify([
        { providerId: "provider-a", supported: ["anthropic"], required: false, current: { apiType: "anthropic", baseUrl: "https://api.anthropic.com" } },
        { providerId: "provider-b", supported: ["openai"], required: false, current: null },
        { providerId: "provider-c", supported: ["openai"], required: false, current: null },
      ]),
      MOCK_PROVIDER_LOG: providerLog,
    };

    const handler = createStepHandler({
      adapter: { id: "codegen", command: "node", label: "Codegen" },
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: new StreamEmitter(),
      task: "build the feature",
      projectRoot: tmpRoot,
      modelRoutingConfig: { variants: { codegen: { cheap: "mock-cheap" } } },
      resolveVariantTier: () => "cheap",
      resolveDowngradeModel: () => "mock-downgrade",
      onProviderQuota: async router => {
        await router.setProvider({ providerId: "provider-c", apiType: "openai", baseUrl: "https://api.openai.com/v1" });
        return { providerId: "provider-c", model: "mock-cheap" };
      },
    });

    const out = await handler(agentStep(), ctx());
    expect(out.status).toBe("completed");
    expect(out.providerFailover).toBe("provider-c");
    expect(out.downgradedTo).toBeUndefined();
    expect(acpState.records.calls).toBe(1);
    expect(acpState.records.variantTiers).toEqual(["cheap"]);
    const providerSets = readLog(providerLog);
    expect(providerSets).toHaveLength(1);
    expect(providerSets[0]).toMatchObject({ providerId: "provider-c" });
  });
});

describe("routing e2e: mock server fidelity", () => {
  it("providers/set makes the target the current provider on the next providers/list (M3)", async () => {
    const s = await rawMockSession({
      MOCK_PROVIDERS: JSON.stringify([
        { providerId: "provider-a", supported: ["anthropic"], required: false, current: { apiType: "anthropic", baseUrl: "https://api.anthropic.com" } },
        { providerId: "provider-b", supported: ["openai"], required: false, current: null },
        { providerId: "provider-c", supported: ["openai"], required: false, current: null },
      ]),
    });
    try {
      await s.call(1, "initialize", {});
      await s.call(2, "session/new", {});
      await s.call(3, "providers/list", {});
      await s.call(4, "providers/set", { providerId: "provider-c", apiType: "openai", baseUrl: "https://api.openai.com/v1" });
      await s.call(5, "providers/list", {});
      expect(s.list(3)).toEqual([
        { providerId: "provider-a", current: true },
        { providerId: "provider-b", current: false },
        { providerId: "provider-c", current: false },
      ]);
      expect(s.list(5)).toEqual([
        { providerId: "provider-a", current: false },
        { providerId: "provider-b", current: false },
        { providerId: "provider-c", current: true },
      ]);
    } finally {
      s.child.stdin.end();
    }
  });

  it("mock server clears its hardTimeout when the connection closes (L2)", async () => {
    const diag = tmpLogPath("routing-close");
    tmpLogs.push(diag);
    const spec = spawnAcpSpec();
    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, MOCK_DIAG: diag },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await new Promise<void>(resolve => child.stdin.end(() => resolve()));
    // Under the 2000ms hardTimeout the child must exit on stdin close; pre-fix
    // it lingered until the timer fired (the ladder's per-rung orphans).
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("mock child did not exit after stdin close — hardTimeout not cleared (L2)")), 1500);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    expect(readLog(diag)).toContainEqual({ mark: "MOCK-CLOSE" });
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