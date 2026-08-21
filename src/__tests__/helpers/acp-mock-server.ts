import * as os from "node:os";
import * as path from "node:path";
import type { AcpSpawnSpec } from "../../application/agents/acp/types.js";

/**
 * Shared minimal ACP agent server over stdio, driven by `MOCK_MODE`:
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
 *
 * `MOCK_QUOTA_MSG` (optional) overrides every quota error message — the e2e
 * uses a "... resets at <epoch-ms> ..." string so the harness sees a
 * deterministic `resetAtMs`. When unset, the built-in per-mode messages are
 * used unchanged.
 */
export const MOCK_SCRIPT = `
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
const authLog = process.env.MOCK_AUTH_LOG;
const authMethods = process.env.MOCK_AUTH_METHODS === '1' ? [
  { id: process.env.MOCK_AUTH_METHOD_ID || 'env-var', name: 'Env var', type: 'env_var',
    vars: [{ name: 'MOCK_API_KEY' }] },
] : undefined;
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
const quotaMessage = process.env.MOCK_QUOTA_MSG;
function quotaErr(msg) { sendPromptError(quotaMessage || msg); }
const hardTimeout = setTimeout(() => {
  answerPrompt({ stopReason:'cancelled', usage:{ totalTokens:1, inputTokens:1, outputTokens:0 } });
  setTimeout(() => process.exit(0), 50);
}, 2000);
// L2: never let the hardTimeout keep an orphaned child alive after the parent
// closes the pipe (the ladder's per-rung children otherwise linger ~2s and
// flake test teardown). Cleared the moment stdin EOFs, then exit immediately.
process.stdin.on('close', () => {
  clearTimeout(hardTimeout);
  if (process.env.MOCK_DIAG) { require('fs').appendFileSync(process.env.MOCK_DIAG, '{"mark":"MOCK-CLOSE"}\\n'); }
  process.exit(0);
});
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
        ...(authMethods ? { authMethods } : {}),
      }});
      break;
case 'authenticate':
      if (authLog) {
        const key = process.env.MOCK_API_KEY;
        const expected = process.env.MOCK_EXPECTED_KEY;
        fs.appendFileSync(authLog, JSON.stringify({ methodId: msg.params && msg.params.methodId, keyInjected: !!key, ...(expected ? { keyMatches: key === expected } : {}) }) + '\\n');
      }
      if (process.env.MOCK_AUTH_REJECT === '1') {
        send({ jsonrpc:'2.0', id, error:{ code:-32001, message:'unknown auth method' } });
      } else {
        send({ jsonrpc:'2.0', id, result: {} });
      }
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
        quotaErr('You exceeded your current quota, please check your plan and billing details.');
} else if (mode === 'quota-downgrade') {
        if (promptCount === 1) {
          quotaErr('You exceeded your current quota for this request [first attempt]');
        } else if (!configDone) {
          // The downgrade path must call set_config_option before the second prompt.
          quotaErr('second prompt arrived before set_config_option');
        } else if (second === 'quota') {
          quotaErr('You exceeded your current quota for this request [second attempt]');
        } else if (second === 'exit') {
          process.exit(0);
        } else {
          answerPrompt({ stopReason:'end_turn', usage:{ totalTokens:7, inputTokens:3, outputTokens:4 } });
        }
      } else if (mode === 'quota-failover') {
        if (promptCount === 1) {
          quotaErr('You exceeded your current quota for this request [first attempt]');
        } else if (!providerSet && !configDone) {
          // A retry prompt is only legitimate after a providers/set (failover)
          // or a set_config_option (downgrade) happened.
          quotaErr('retry prompt arrived before any provider switch or config');
        } else if (second === 'quota') {
          quotaErr('You exceeded your current quota for this request [second attempt]');
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
        // M3 (ADR-021): providers/set makes the target the current provider —
        // clears every other provider's current so a later providers/list
        // shows the switch, exactly like a real router would.
        const cfg = msg.params || {};
        providers.forEach(p => { p.current = null; });
        const target = providers.find(p => p.providerId === cfg.providerId);
        if (target) {
          target.current = {
            apiType: cfg.apiType,
            baseUrl: cfg.baseUrl,
            ...(cfg.headers ? { headers: cfg.headers } : {}),
          };
        }
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

/** Spawn spec that runs the shared mock ACP server under the current Node. */
export function spawnAcpSpec(): AcpSpawnSpec {
  return { command: process.execPath, args: ["-e", MOCK_SCRIPT] };
}

/** Minimal child env for a mock-agent turn. `mode` sets MOCK_MODE. */
export function acpEnv(mode: string, extra: Record<string, string> = {}): Record<string, string> {
  return { MOCK_MODE: mode, PATH: process.env.PATH ?? "", ...extra };
}

/** A unique temp path for a mock log file (cfg/provider/auth), cleaned up by the caller. */
export function tmpLogPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`);
}