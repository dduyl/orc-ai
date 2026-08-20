import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAcpTurn } from "../../../../application/agents/acp/client.js";
import { PermissionGate } from "../../../../application/agents/acp/permission.js";
import { AgentCallError } from "../../../../application/agents/errors.js";
import type { AcpSpawnSpec } from "../../../../application/agents/acp/types.js";

/**
 * Minimal ACP agent server over stdio, driven by `MOCK_MODE`:
 *  - stream:     responds end_turn with usage; streams two text chunks.
 *  - cancel:     streams one chunk on session/new, then defers the prompt
 *                response until it sees `session/cancel`.
 *  - crash-init: never answers `initialize` and exits shortly after, so the
 *                connection dies inside the initialize window.
 *  - exit:       closes the connection on the prompt request.
 *  - quota-failover: first prompt quota-fails; a retry prompt is only answered
 *                once a providers/set (failover) or set_config_option
 *                (downgrade) has happened. `MOCK_SECOND` drives the retry.
 *
 * Provider-failover knobs: `MOCK_PROVIDER_CAP=1` advertises the `providers`
 * capability at initialize; `MOCK_PROVIDERS` is a JSON array of providers;
 * `MOCK_PROVIDER_SET=reject` makes providers/set fail; `MOCK_PROVIDER_LOG`
 * records each providers/set payload.
 */
const MOCK_SCRIPT = `
const readline = require('readline');
const fs = require('fs');
const mode = process.env.MOCK_MODE || 'stream';
const second = process.env.MOCK_SECOND || 'stream';
const cfg = process.env.MOCK_CFG || 'ok';
const modelCfg = process.env.MOCK_MODEL_CFG === '1';
const advertised = (process.env.MOCK_MODEL_ADVERTISED || 'default,mock-strong-a,mock-strong-b,mock-cheap').split(',');
const cfgLog = process.env.MOCK_CFG_LOG;
const rl = readline.createInterface({ input: process.stdin });
let pendingPrompt = null;
let promptCount = 0;
let configDone = false;
const providerCap = process.env.MOCK_PROVIDER_CAP === '1';
const providers = (process.env.MOCK_PROVIDERS ? JSON.parse(process.env.MOCK_PROVIDERS) : [
  { providerId:'provider-a', supported:['anthropic'], required:false, current:{ apiType:'anthropic', baseUrl:'https://api.anthropic.com' } },
  { providerId:'provider-b', supported:['openai'], required:false, current:null },
]);
const providerSetMode = process.env.MOCK_PROVIDER_SET || 'ok';
const providerLog = process.env.MOCK_PROVIDER_LOG;
let providerSet = false;
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
function sendUpdate(sessionId, text) {
  send({ jsonrpc:'2.0', method:'session/update', params: {
    sessionId,
    update: { sessionUpdate:'agent_message_chunk', content:{ type:'text', text } },
  }});
}
function answerPrompt(result) {
  if (!pendingPrompt) return;
  const { id } = pendingPrompt;
  pendingPrompt = null;
  send({ jsonrpc:'2.0', id, result });
}
function sendPromptError(message) {
  if (!pendingPrompt) return;
  const { id } = pendingPrompt;
  pendingPrompt = null;
  send({ jsonrpc:'2.0', id, error:{ code:-32000, message } });
}
const hardTimeout = setTimeout(() => {
  answerPrompt({ stopReason:'cancelled', usage:{ totalTokens:1, inputTokens:1, outputTokens:0 } });
  setTimeout(() => process.exit(0), 50);
}, 2000);
process.on('uncaughtException', (e) => {
  if (process.env.MOCK_DIAG) { require('fs').appendFileSync(process.env.MOCK_DIAG, 'MOCK-UNCAUGHT: ' + (e && e.stack || e) + '\\n'); }
  process.exit(1);
});
rl.on('line', (line) => {
  try {
  const msg = JSON.parse(line);
  const { id, method } = msg;
  switch (method) {
    case 'initialize':
      if (mode === 'crash-init') {
        setTimeout(() => process.exit(0), 100);
        break;
      }
      send({ jsonrpc:'2.0', id, result: {
        protocolVersion: 1,
        agentCapabilities: providerCap ? { providers: {} } : {},
        agentInfo: { name: 'mock-agent', version: '1.0.0' },
      }});
      break;
    case 'session/new':
      send({ jsonrpc:'2.0', id, result: {
        sessionId: 'sess-1',
        ...(modelCfg ? { configOptions: [
          { id:'model', category:'model', type:'select', currentValue: advertised[0],
            options: advertised.map(v => ({ value: v, name: v })) },
        ] } : {}),
      } });
      if (mode === 'stream' || mode === 'cancel') {
        sendUpdate('sess-1', 'hello ');
      }
      if (mode === 'stream') {
        sendUpdate('sess-1', 'world');
      }
      break;
    case 'session/prompt':
      pendingPrompt = { id };
      promptCount++;
      if (mode === 'stream') {
        answerPrompt({ stopReason:'end_turn', usage:{ totalTokens:42, inputTokens:10, outputTokens:32 } });
      } else if (mode === 'exit') {
        process.exit(0);
      } else if (mode === 'quota') {
        sendPromptError('You exceeded your current quota, please check your plan and billing details.');
} else if (mode === 'quota-downgrade') {
        if (promptCount === 1) {
          sendPromptError('You exceeded your current quota for this request [first attempt]');
        } else if (!configDone) {
          // The downgrade path must call set_config_option before the second prompt.
          sendPromptError('second prompt arrived before set_config_option');
        } else if (second === 'quota') {
          sendPromptError('You exceeded your current quota for this request [second attempt]');
        } else if (second === 'exit') {
          process.exit(0);
        } else {
          answerPrompt({ stopReason:'end_turn', usage:{ totalTokens:7, inputTokens:3, outputTokens:4 } });
        }
      } else if (mode === 'quota-failover') {
        if (promptCount === 1) {
          sendPromptError('You exceeded your current quota for this request [first attempt]');
        } else if (!providerSet && !configDone) {
          // A retry prompt is only legitimate after a providers/set (failover)
          // or a set_config_option (downgrade) happened.
          sendPromptError('retry prompt arrived before any provider switch or config');
        } else if (second === 'quota') {
          sendPromptError('You exceeded your current quota for this request [second attempt]');
        } else if (second === 'exit') {
          process.exit(0);
        } else {
          answerPrompt({ stopReason:'end_turn', usage:{ totalTokens:7, inputTokens:3, outputTokens:4 } });
        }
      }
      break;
    case 'session/set_config_option':
      if (cfgLog) {
        fs.appendFileSync(cfgLog, JSON.stringify({ configId: msg.params.configId, value: msg.params.value }) + '\\n');
      }
      if (cfg === 'reject') {
        send({ jsonrpc:'2.0', id, error:{ code:-32001, message:'unknown config id: model' } });
      } else {
        configDone = true;
        send({ jsonrpc:'2.0', id, result: {} });
      }
      break;
    case 'providers/list':
      send({ jsonrpc:'2.0', id, result: { providers } });
      break;
    case 'providers/set':
      if (providerLog) {
        fs.appendFileSync(providerLog, JSON.stringify(msg.params) + '\\n');
      }
      if (providerSetMode === 'reject') {
        send({ jsonrpc:'2.0', id, error:{ code:-32001, message:'providers/set rejected' } });
      } else {
        providerSet = true;
        send({ jsonrpc:'2.0', id, result: {} });
      }
      break;
    case 'session/cancel':
      answerPrompt({ stopReason:'cancelled', usage:{ totalTokens:5, inputTokens:2, outputTokens:3 } });
      break;
    default:
      if (id !== undefined) {
        send({ jsonrpc:'2.0', id, error:{ code:-32601, message:'method not found: ' + method } });
      }
  }
  } catch (e) {
    if (process.env.MOCK_DIAG) { require('fs').appendFileSync(process.env.MOCK_DIAG, 'MOCK-LINE-ERR: ' + (e && e.stack || e) + '\\n'); }
    process.exit(1);
  }
});
`;

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
});
