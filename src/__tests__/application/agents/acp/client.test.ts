import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAcpTurn } from "../../../../application/agents/acp/client.js";
import { defaultOnProviderQuota } from "../../../../application/harness/orchestrator/routing-defaults.js";
import { PermissionGate } from "../../../../application/agents/acp/permission.js";
import { AgentCallError } from "../../../../application/agents/errors.js";
import { log } from "../../../../core/log.js";
import { MOCK_SCRIPT } from "../../../helpers/acp-mock-server.js";
import type { AcpSpawnSpec } from "../../../../application/agents/acp/types.js";

/**
 * The mock agent server (see `src/__tests__/helpers/acp-mock-server.ts`) is
 * shared with the routing e2e so the two suites never diverge.
 */
function spawnSpec(mode: string): AcpSpawnSpec {
  return { command: process.execPath, args: ["-e", MOCK_SCRIPT] };
}

function env(mode: string, extra: Record<string, string> = {}): Record<string, string> {
  return { MOCK_MODE: mode, PATH: process.env.PATH ?? "", ...extra };
}

function tmpCfgLog(): string {
  return path.join(os.tmpdir(), `acp-cfg-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`);
}

function readCfgLog(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("runAcpTurn", () => {
  it("streams text chunks and normalizes usage", async () => {
    const chunks: string[] = [];
    const turn = await runAcpTurn({
      spawn: spawnSpec("stream"),
      cwd: process.cwd(),
      env: env("stream"),
      prompt: "hello",
      permissionGate: new PermissionGate(),
      events: { onText: text => chunks.push(text) },
    });

    expect(turn.stopReason).toBe("end_turn");
    expect(turn.content).toBe("hello world");
    expect(chunks).toEqual(["hello ", "world"]);
    expect(turn.usage).toMatchObject({ totalTokens: 42, inputTokens: 10, outputTokens: 32 });
    expect(turn.duration).toBeGreaterThanOrEqual(0);
    expect(turn.error).toBeUndefined();
  });

  it("resolves as cancelled when the signal aborts mid-turn (no unhandled rejection)", async () => {
    const controller = new AbortController();
    let resolveText!: () => void;
    const sawText = new Promise<void>(res => {
      resolveText = res;
    });
    const turnPromise = runAcpTurn({
      spawn: spawnSpec("cancel"),
      cwd: process.cwd(),
      env: env("cancel"),
      prompt: "hello",
      permissionGate: new PermissionGate(),
      signal: controller.signal,
      events: { onText: () => resolveText() },
    });

    // Deterministic mid-flight marker: the mock streams on session/new, before
    // the prompt response, so the turn cannot have completed yet.
    await sawText;
    controller.abort();
    const turn = await turnPromise;

    expect(turn.stopReason).toBe("cancelled");
    expect(turn.content).toBe("hello ");
  });

  it("settles as cancelled when the signal aborts during the initialize window", async () => {
    const controller = new AbortController();
    const turnPromise = runAcpTurn({
      spawn: spawnSpec("crash-init"),
      cwd: process.cwd(),
      env: env("crash-init"),
      prompt: "hello",
      permissionGate: new PermissionGate(),
      signal: controller.signal,
    });

    // Abort while initialize is in flight (the mock never answers it). The
    // abort must be observed from the very start of the turn, not only after a
    // session exists, and must settle as cancelled — never reject.
    await new Promise(r => setTimeout(r, 20));
    controller.abort();
    const turn = await turnPromise;

    expect(turn.stopReason).toBe("cancelled");
    expect(turn.content).toBe("");
  });

  it("rejects (does not hang) when the spawn fails", async () => {
    const err = await runAcpTurn({
      spawn: { command: "definitely-not-a-real-binary-xyz-12345", args: [] },
      cwd: process.cwd(),
      env: {},
      prompt: "hello",
      permissionGate: new PermissionGate(),
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("spawn");
    expect((err as AgentCallError).message).toMatch(/Failed to spawn ACP agent/);
  });

  it("rejects when the server closes the connection mid-turn", async () => {
    const err = await runAcpTurn({
      spawn: spawnSpec("exit"),
      cwd: process.cwd(),
      env: env("exit"),
      prompt: "hello",
      permissionGate: new PermissionGate(),
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("connection");
  });

  it("wraps a quota session/prompt rejection as a thrown AgentCallError (kind preserved)", async () => {
    const err = await runAcpTurn({
      spawn: spawnSpec("quota"),
      cwd: process.cwd(),
      env: env("quota"),
      prompt: "hello",
      permissionGate: new PermissionGate(),
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect((err as AgentCallError).message).toMatch(/quota/);
  });

  it("quota → downgradeTo → second prompt succeeds: resolves with downgraded=true", async () => {
    const turn = await runAcpTurn({
      spawn: spawnSpec("quota-downgrade"),
      cwd: process.cwd(),
      env: env("quota-downgrade", { MOCK_SECOND: "stream" }),
      prompt: "hello",
      downgradeTo: "claude-haiku",
      permissionGate: new PermissionGate(),
    });

    expect(turn.stopReason).toBe("end_turn");
    expect(turn.downgraded).toBe(true);
    expect(turn.error).toBeUndefined();
  });

  it("quota → downgradeTo → set_config_option rejects: rethrows the ORIGINAL quota error (no second prompt)", async () => {
    const err = await runAcpTurn({
      spawn: spawnSpec("quota-downgrade"),
      cwd: process.cwd(),
      env: env("quota-downgrade", { MOCK_CFG: "reject" }),
      prompt: "hello",
      downgradeTo: "claude-haiku",
      permissionGate: new PermissionGate(),
    }).then(
      () => null,
      e => e,
    );

expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect((err as AgentCallError).message).toBe("You exceeded your current quota for this request [first attempt]");
  });

  it("quota → downgradeTo → second prompt quota-fails: rethrows the SECOND quota error", async () => {
    const err = await runAcpTurn({
      spawn: spawnSpec("quota-downgrade"),
      cwd: process.cwd(),
      env: env("quota-downgrade", { MOCK_SECOND: "quota" }),
      prompt: "hello",
      downgradeTo: "claude-haiku",
      permissionGate: new PermissionGate(),
    }).then(
      () => null,
      e => e,
    );

expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect((err as AgentCallError).message).toBe("You exceeded your current quota for this request [second attempt]");
  });

  it("quota → downgradeTo → second prompt non-quota (connection close): propagates the non-quota error", async () => {
    const err = await runAcpTurn({
      spawn: spawnSpec("quota-downgrade"),
      cwd: process.cwd(),
      env: env("quota-downgrade", { MOCK_SECOND: "exit" }),
      prompt: "hello",
      downgradeTo: "claude-haiku",
      permissionGate: new PermissionGate(),
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("connection");
  });

  it("non-quota first rejection with downgradeTo set: no downgrade attempted, original error rethrown", async () => {
    const err = await runAcpTurn({
      spawn: spawnSpec("exit"),
      cwd: process.cwd(),
      env: env("exit"),
      prompt: "hello",
      downgradeTo: "claude-haiku",
      permissionGate: new PermissionGate(),
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("connection");
  });

  it("ADR-021 variantTier pre-configures the cheapest-of-tier advertised model before the first prompt", async () => {
    const cfgLog = tmpCfgLog();
    try {
      const turn = await runAcpTurn({
        spawn: spawnSpec("stream"),
        cwd: process.cwd(),
        env: env("stream", {
          MOCK_MODEL_CFG: "1",
          // Advertised strong models, cheapest listed SECOND: the selector must
          // pick by price, not advertised order.
          MOCK_MODEL_ADVERTISED: "claude-opus-4-7,claude-sonnet-4-6",
          MOCK_CFG_LOG: cfgLog,
        }),
        prompt: "hello",
        variantTier: "strong",
        configuredProviders: ["anthropic"],
        permissionGate: new PermissionGate(),
      });

      expect(turn.stopReason).toBe("end_turn");
      expect(turn.configuredModel).toBe("claude-sonnet-4-6");
      // Recorded server-side: the set_config_option carried the selected model.
      expect(readCfgLog(cfgLog)).toEqual(
        expect.arrayContaining([expect.stringContaining('"value":"claude-sonnet-4-6"')]),
      );
    } finally {
      if (fs.existsSync(cfgLog)) fs.unlinkSync(cfgLog);
    }
  });

  it("ADR-021 variantModel override is applied even when not advertised", async () => {
    const cfgLog = tmpCfgLog();
    try {
      const turn = await runAcpTurn({
        spawn: spawnSpec("stream"),
        cwd: process.cwd(),
        env: env("stream", {
          MOCK_MODEL_CFG: "1",
          MOCK_MODEL_ADVERTISED: "claude-opus-4-7,claude-sonnet-4-6",
          MOCK_CFG_LOG: cfgLog,
        }),
        prompt: "hello",
        variantTier: "strong",
        variantModel: "custom-flagged-model",
        configuredProviders: ["anthropic"],
        permissionGate: new PermissionGate(),
      });

      expect(turn.stopReason).toBe("end_turn");
      expect(turn.configuredModel).toBe("custom-flagged-model");
      expect(readCfgLog(cfgLog)).toEqual(
        expect.arrayContaining([expect.stringContaining('"value":"custom-flagged-model"')]),
      );
    } finally {
      if (fs.existsSync(cfgLog)) fs.unlinkSync(cfgLog);
    }
  });

  it("ADR-021 cheap tier pre-configures the cheapest-of-tier advertised cheap model", async () => {
    const cfgLog = tmpCfgLog();
    try {
      const turn = await runAcpTurn({
        spawn: spawnSpec("stream"),
        cwd: process.cwd(),
        env: env("stream", {
          MOCK_MODEL_CFG: "1",
          MOCK_MODEL_ADVERTISED: "claude-sonnet-4-6,claude-haiku-4-5",
          MOCK_CFG_LOG: cfgLog,
        }),
        prompt: "hello",
        variantTier: "cheap",
        configuredProviders: ["anthropic"],
        permissionGate: new PermissionGate(),
      });

      expect(turn.stopReason).toBe("end_turn");
      expect(turn.configuredModel).toBe("claude-haiku-4-5");
      expect(readCfgLog(cfgLog)).toEqual(
        expect.arrayContaining([expect.stringContaining('"value":"claude-haiku-4-5"')]),
      );
    } finally {
      if (fs.existsSync(cfgLog)) fs.unlinkSync(cfgLog);
    }
  });

  it("ADR-021 no advertised model select: tier is inert, agent default runs, no config sent", async () => {
    const cfgLog = tmpCfgLog();
    try {
      const turn = await runAcpTurn({
        spawn: spawnSpec("stream"),
        cwd: process.cwd(),
        env: env("stream", { MOCK_CFG_LOG: cfgLog }),
        prompt: "hello",
        variantTier: "strong",
        configuredProviders: ["anthropic"],
        permissionGate: new PermissionGate(),
      });

      expect(turn.stopReason).toBe("end_turn");
      expect(turn.configuredModel).toBeUndefined();
      expect(readCfgLog(cfgLog)).toEqual([]);
    } finally {
      if (fs.existsSync(cfgLog)) fs.unlinkSync(cfgLog);
    }
  });

  it("ADR-021 no configured providers: classification is empty, agent default runs, no config sent", async () => {
    const cfgLog = tmpCfgLog();
    try {
      const turn = await runAcpTurn({
        spawn: spawnSpec("stream"),
        cwd: process.cwd(),
        env: env("stream", {
          MOCK_MODEL_CFG: "1",
          MOCK_MODEL_ADVERTISED: "claude-sonnet-4-6,claude-haiku-4-5",
          MOCK_CFG_LOG: cfgLog,
        }),
        prompt: "hello",
        variantTier: "strong",
        configuredProviders: [],
        permissionGate: new PermissionGate(),
      });

      expect(turn.stopReason).toBe("end_turn");
      expect(turn.configuredModel).toBeUndefined();
      expect(readCfgLog(cfgLog)).toEqual([]);
    } finally {
      if (fs.existsSync(cfgLog)) fs.unlinkSync(cfgLog);
    }
  });

  it("ADR-021 rejected pre-emptive config never halts the turn (agent default)", async () => {
    const turn = await runAcpTurn({
      spawn: spawnSpec("stream"),
      cwd: process.cwd(),
      env: env("stream", { MOCK_MODEL_CFG: "1", MOCK_CFG: "reject" }),
      prompt: "hello",
      variantTier: "strong",
      variantModel: "custom-flagged-model",
      configuredProviders: ["anthropic"],
      permissionGate: new PermissionGate(),
    });

    expect(turn.stopReason).toBe("end_turn");
    expect(turn.configuredModel).toBeUndefined();
    expect(turn.error).toBeUndefined();
  });

  it("ADR-021 quota → onProviderQuota switches provider → second prompt succeeds on the new provider", async () => {
    const cfgLog = tmpCfgLog();
    const setLog = tmpCfgLog();
    const calls: string[] = [];
    try {
      const turn = await runAcpTurn({
        spawn: spawnSpec("quota-failover"),
        cwd: process.cwd(),
        env: env("quota-failover", {
          MOCK_PROVIDER_CAP: "1",
          MOCK_CFG_LOG: cfgLog,
          MOCK_PROVIDER_LOG: setLog,
        }),
        prompt: "hello",
        variantTier: "cheap",
        permissionGate: new PermissionGate(),
        onProviderQuota: async (router, context) => {
          calls.push(`list:${context.tier}`);
          const next = (await router.listProviders()).find(p => p.providerId === "provider-b");
          if (!next) return undefined;
          await router.setProvider({
            providerId: next.providerId,
            apiType: "openai",
            baseUrl: "https://api.openai.com",
            headers: { "x-key": "k" },
          });
          calls.push("set:provider-b");
          return { providerId: next.providerId, model: "claude-haiku-4-5" };
        },
      });

      expect(turn.stopReason).toBe("end_turn");
      expect(turn.providerFailover).toBe("provider-b");
      expect(turn.configuredModel).toBe("claude-haiku-4-5");
      expect(turn.downgraded).toBeUndefined();
      expect(calls).toEqual(["list:cheap", "set:provider-b"]);
      // The failover model was re-applied via set_config_option after the switch.
      expect(readCfgLog(cfgLog)).toEqual([expect.stringContaining('"value":"claude-haiku-4-5"')]);
      // providers/set carried the routed config (non-secret fields only).
      expect(readCfgLog(setLog)).toEqual([expect.stringContaining('"providerId":"provider-b"')]);
    } finally {
      for (const f of [cfgLog, setLog]) if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it("ADR-021 (M4) quota → onProviderQuota context carries the configured provider block (regression)", async () => {
    const setLog = tmpCfgLog();
    try {
      const turn = await runAcpTurn({
        spawn: spawnSpec("quota-failover"),
        cwd: process.cwd(),
        env: env("quota-failover", {
          MOCK_PROVIDER_CAP: "1",
          MOCK_PROVIDER_LOG: setLog,
        }),
        prompt: "hello",
        permissionGate: new PermissionGate(),
        onProviderQuota: defaultOnProviderQuota(["provider-b"]),
        providerConfig: {
          "provider-b": {
            apiType: "anthropic",
            baseUrl: "https://api.custom-anthropic.example",
            headers: { "x-custom": "h" },
          },
        },
      });

      expect(turn.stopReason).toBe("end_turn");
      expect(turn.providerFailover).toBe("provider-b");
      const logged = readCfgLog(setLog);
      // providers/set was built from the context's config block, not the
      // advertised `current` (provider-b advertises none) nor a fallback default.
      expect(logged).toEqual([expect.stringContaining('"providerId":"provider-b"')]);
      expect(logged).toEqual([expect.stringContaining('"apiType":"anthropic"')]);
      expect(logged).toEqual([expect.stringContaining('"baseUrl":"https://api.custom-anthropic.example"')]);
      expect(logged).toEqual([expect.stringContaining('"headers":{"x-custom":"h"}')]);
    } finally {
      if (fs.existsSync(setLog)) fs.unlinkSync(setLog);
    }
  });

  it("ADR-021 (M4) provider without a config block → providers/set falls back to the advertised current", async () => {
    const setLog = tmpCfgLog();
    try {
      const turn = await runAcpTurn({
        spawn: spawnSpec("quota-failover"),
        cwd: process.cwd(),
        env: env("quota-failover", {
          MOCK_PROVIDER_CAP: "1",
          MOCK_PROVIDER_LOG: setLog,
          MOCK_PROVIDERS: JSON.stringify([
            { providerId: "provider-a", supported: ["openai"], required: false, current: null },
            { providerId: "provider-b", supported: ["openai"], required: false, current: { apiType: "openai", baseUrl: "https://api.openai.com" } },
          ]),
        }),
        prompt: "hello",
        permissionGate: new PermissionGate(),
        onProviderQuota: defaultOnProviderQuota(["provider-a"]),
      });

      expect(turn.stopReason).toBe("end_turn");
      expect(turn.providerFailover).toBe("provider-a");
      const logged = readCfgLog(setLog);
      expect(logged).toEqual([expect.stringContaining('"providerId":"provider-a"')]);
      expect(logged).toEqual([expect.stringContaining('"apiType":"openai"')]);
      // No config block was supplied, so the seam falls back to defaults rather
      // than carrying a config-derived payload (and sends no headers).
      expect(logged).toEqual([expect.stringContaining('"baseUrl":""')]);
      expect(logged[0]).not.toContain('"headers"');
    } finally {
      if (fs.existsSync(setLog)) fs.unlinkSync(setLog);
    }
  });

  it("ADR-021 (M4) failover switches to the provider id from providers/list, not the adapter id", async () => {
    const setLog = tmpCfgLog();
    try {
      const turn = await runAcpTurn({
        spawn: spawnSpec("quota-failover"),
        cwd: process.cwd(),
        env: env("quota-failover", {
          MOCK_PROVIDER_CAP: "1",
          MOCK_PROVIDER_LOG: setLog,
          MOCK_PROVIDERS: JSON.stringify([
            { providerId: "alpha", supported: ["anthropic"], required: false, current: { apiType: "anthropic", baseUrl: "https://api.anthropic.com" } },
            { providerId: "beta", supported: ["openai"], required: false, current: null },
          ]),
        }),
        prompt: "hello",
        permissionGate: new PermissionGate(),
        onProviderQuota: defaultOnProviderQuota(["beta"]),
        providerConfig: {
          beta: { apiType: "openai", baseUrl: "https://api.openai.com/v1", headers: { "x-key": "k" } },
        },
      });

      expect(turn.stopReason).toBe("end_turn");
      expect(turn.providerFailover).toBe("beta");
      const logged = readCfgLog(setLog);
      // The id switched to is the listed provider id ("beta"), never the agent
      // process/adapter identity.
      expect(logged).toEqual([expect.stringContaining('"providerId":"beta"')]);
      expect(logged).toEqual([expect.stringContaining('"apiType":"openai"')]);
      expect(logged).toEqual([expect.stringContaining('"baseUrl":"https://api.openai.com/v1"')]);
    } finally {
      if (fs.existsSync(setLog)) fs.unlinkSync(setLog);
    }
  });

  it("ADR-021 failover runs BEFORE the same-session downgrade path", async () => {
    const calls: string[] = [];
    const turn = await runAcpTurn({
      spawn: spawnSpec("quota-failover"),
      cwd: process.cwd(),
      env: env("quota-failover", { MOCK_PROVIDER_CAP: "1" }),
      prompt: "hello",
      downgradeTo: "claude-haiku",
      permissionGate: new PermissionGate(),
      onProviderQuota: async router => {
        const next = (await router.listProviders()).find(p => p.providerId === "provider-b");
        if (!next) return undefined;
        await router.setProvider({ providerId: next.providerId, apiType: "openai", baseUrl: "https://x" });
        calls.push("set:provider-b");
        return { providerId: next.providerId };
      },
    });

    expect(turn.stopReason).toBe("end_turn");
    expect(turn.providerFailover).toBe("provider-b");
    expect(turn.downgraded).toBeUndefined();
    expect(calls).toEqual(["set:provider-b"]);
  });

  it("ADR-021 both attempts quota: failover runs per quota hit, then falls through on the second quota", async () => {
    const calls: string[] = [];
    const tried = new Set<string>();
    const err = await runAcpTurn({
      spawn: spawnSpec("quota-failover"),
      cwd: process.cwd(),
      env: env("quota-failover", { MOCK_PROVIDER_CAP: "1", MOCK_SECOND: "quota" }),
      prompt: "hello",
      permissionGate: new PermissionGate(),
      onProviderQuota: async router => {
        const next = (await router.listProviders()).find(p => p.providerId === "provider-b" && !tried.has(p.providerId));
        if (!next) return undefined;
        tried.add(next.providerId);
        await router.setProvider({ providerId: next.providerId, apiType: "openai", baseUrl: "https://x" });
        calls.push(`set:${next.providerId}`);
        return { providerId: next.providerId };
      },
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect((err as AgentCallError).message).toBe("You exceeded your current quota for this request [second attempt]");
    expect((err as AgentCallError).providerId).toBe("provider-b");
    expect((err as AgentCallError).authMethods).toEqual([]);
    expect(calls).toEqual(["set:provider-b"]);
  });

  it("ADR-021 failover with no alternative provider: falls through and rethrows the ORIGINAL quota error", async () => {
    const err = await runAcpTurn({
      spawn: spawnSpec("quota-failover"),
      cwd: process.cwd(),
      env: env("quota-failover", {
        MOCK_PROVIDER_CAP: "1",
        MOCK_PROVIDERS: JSON.stringify([
          { providerId: "provider-a", supported: ["anthropic"], required: false, current: null },
        ]),
      }),
      prompt: "hello",
      permissionGate: new PermissionGate(),
      onProviderQuota: async router => {
        const next = (await router.listProviders()).find(p => p.providerId === "provider-b");
        return next ? { providerId: next.providerId } : undefined;
      },
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect((err as AgentCallError).message).toBe("You exceeded your current quota for this request [first attempt]");
  });

  it("ADR-021 failover whose providers/set rejects: falls through and rethrows the ORIGINAL quota error", async () => {
    const err = await runAcpTurn({
      spawn: spawnSpec("quota-failover"),
      cwd: process.cwd(),
      env: env("quota-failover", { MOCK_PROVIDER_CAP: "1", MOCK_PROVIDER_SET: "reject" }),
      prompt: "hello",
      permissionGate: new PermissionGate(),
      onProviderQuota: async router => {
        const next = (await router.listProviders()).find(p => p.providerId === "provider-b");
        if (!next) return undefined;
        await router.setProvider({ providerId: next.providerId, apiType: "openai", baseUrl: "https://x" });
        return { providerId: next.providerId, model: "claude-haiku-4-5" };
      },
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect((err as AgentCallError).message).toBe("You exceeded your current quota for this request [first attempt]");
  });

  it("ADR-021 failover whose model config rejects: session stays on the new provider, agent default runs", async () => {
    const turn = await runAcpTurn({
      spawn: spawnSpec("quota-failover"),
      cwd: process.cwd(),
      env: env("quota-failover", { MOCK_PROVIDER_CAP: "1", MOCK_CFG: "reject" }),
      prompt: "hello",
      permissionGate: new PermissionGate(),
      onProviderQuota: async router => {
        const next = (await router.listProviders()).find(p => p.providerId === "provider-b");
        if (!next) return undefined;
        await router.setProvider({ providerId: next.providerId, apiType: "openai", baseUrl: "https://x" });
        return { providerId: next.providerId, model: "claude-haiku-4-5" };
      },
    });

    expect(turn.stopReason).toBe("end_turn");
    expect(turn.providerFailover).toBe("provider-b");
    expect(turn.configuredModel).toBeUndefined();
  });

  it("ADR-021 agent without providers capability: failover seam is not invoked, original quota rethrown", async () => {
    const calls: string[] = [];
    const err = await runAcpTurn({
      spawn: spawnSpec("quota-failover"),
      cwd: process.cwd(),
      env: env("quota-failover"),
      prompt: "hello",
      permissionGate: new PermissionGate(),
      onProviderQuota: async () => {
        calls.push("seam");
        return { providerId: "provider-b" };
      },
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect(calls).toEqual([]);
  });

  it("ADR-021 failover seam throwing: falls through to the downgrade path", async () => {
    const turn = await runAcpTurn({
      spawn: spawnSpec("quota-failover"),
      cwd: process.cwd(),
      env: env("quota-failover", { MOCK_PROVIDER_CAP: "1" }),
      prompt: "hello",
      downgradeTo: "claude-haiku",
      permissionGate: new PermissionGate(),
      onProviderQuota: async () => {
        throw new Error("router exploded");
      },
    });

    expect(turn.stopReason).toBe("end_turn");
    expect(turn.downgraded).toBe(true);
    expect(turn.providerFailover).toBeUndefined();
  });

  it("ADR-021 token-paid: key injected into child env + authenticate called, then quota carries authMethods", async () => {
    const authFile = tmpCfgLog();
    try {
      const err = await runAcpTurn({
        spawn: spawnSpec("quota"),
        cwd: process.cwd(),
        env: env("quota", { MOCK_AUTH_METHODS: "1", MOCK_AUTH_LOG: authFile }),
        prompt: "hello",
        tokenPaid: { methodId: "env-var", envVarName: "MOCK_API_KEY", key: "sk-tokenpaid-secret" },
        permissionGate: new PermissionGate(),
      }).then(
        () => null,
        e => e,
      );

      expect(err).toBeInstanceOf(AgentCallError);
      expect((err as AgentCallError).kind).toBe("quota");
      expect((err as AgentCallError).message).toMatch(/quota/);
      expect((err as AgentCallError).authMethods).toEqual([{ methodId: "env-var", envVarName: "MOCK_API_KEY" }]);
      expect((err as AgentCallError).providerId).toBeUndefined();
      // Server-side: authenticate was asked for the token-paid method, and the
      // child environment had the key injected at MOCK_API_KEY.
      expect(readCfgLog(authFile)).toEqual([expect.stringContaining('"methodId":"env-var"')]);
      expect(readCfgLog(authFile)).toEqual([expect.stringContaining('"keyInjected":true')]);
    } finally {
      if (fs.existsSync(authFile)) fs.unlinkSync(authFile);
    }
  });

  it("ADR-021 token-paid: authenticate rejection surfaces quota 'token-paid authenticate failed' (no prompt)", async () => {
    const err = await runAcpTurn({
      spawn: spawnSpec("stream"),
      cwd: process.cwd(),
      env: env("stream", { MOCK_AUTH_METHODS: "1", MOCK_AUTH_REJECT: "1" }),
      prompt: "hello",
      tokenPaid: { methodId: "env-var", envVarName: "MOCK_API_KEY", key: "sk-tokenpaid-secret" },
      permissionGate: new PermissionGate(),
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect((err as AgentCallError).message).toMatch(/token-paid authenticate failed/);
    expect((err as AgentCallError).authMethods).toEqual([{ methodId: "env-var", envVarName: "MOCK_API_KEY" }]);
  });

  it("ADR-021 token-paid: no failover/downgrade recovery — seam never invoked, first quota rethrown", async () => {
    const calls: string[] = [];
    const err = await runAcpTurn({
      spawn: spawnSpec("quota-failover"),
      cwd: process.cwd(),
      env: env("quota-failover", { MOCK_PROVIDER_CAP: "1", MOCK_AUTH_METHODS: "1" }),
      prompt: "hello",
      downgradeTo: "claude-haiku",
      tokenPaid: { methodId: "env-var", envVarName: "MOCK_API_KEY", key: "sk-tokenpaid-secret" },
      permissionGate: new PermissionGate(),
      onProviderQuota: async () => {
        calls.push("seam");
        return { providerId: "provider-b" };
      },
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect((err as AgentCallError).message).toBe("You exceeded your current quota for this request [first attempt]");
    expect(calls).toEqual([]);
  });

  it("ADR-021 non-token-paid quota advertises the env-var auth method for the harness", async () => {
    const err = await runAcpTurn({
      spawn: spawnSpec("quota"),
      cwd: process.cwd(),
      env: env("quota", { MOCK_AUTH_METHODS: "1" }),
      prompt: "hello",
      permissionGate: new PermissionGate(),
    }).then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect((err as AgentCallError).authMethods).toEqual([{ methodId: "env-var", envVarName: "MOCK_API_KEY" }]);
  });

  it("ADR-021 token-paid: the injected key never appears in the acp log", async () => {
    const KEY = "sk-tokenpaid-secret";
    const entries: string[] = [];
    const unsub = log.subscribe(e => entries.push(e.message));
    try {
      const err = await runAcpTurn({
        spawn: spawnSpec("quota"),
        cwd: process.cwd(),
        env: env("quota", { MOCK_AUTH_METHODS: "1" }),
        prompt: "hello",
        tokenPaid: { methodId: "env-var", envVarName: "MOCK_API_KEY", key: KEY },
        permissionGate: new PermissionGate(),
      }).then(
        () => null,
        e => e,
      );
      expect(err).toBeInstanceOf(AgentCallError);
    } finally {
      unsub();
    }
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(m => m.includes(KEY))).toBe(false);
  });
});
