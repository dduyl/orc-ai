import { describe, it, expect } from "vitest";
import { runAcpTurn } from "../../../../application/agents/acp/client.js";
import { PermissionGate } from "../../../../application/agents/acp/permission.js";
import type { AcpSpawnSpec } from "../../../../application/agents/acp/types.js";

/**
 * Minimal ACP agent server over stdio, driven by `MOCK_MODE`:
 *  - stream:     responds end_turn with usage; streams two text chunks.
 *  - cancel:     streams one chunk on session/new, then defers the prompt
 *                response until it sees `session/cancel`.
 *  - crash-init: never answers `initialize` and exits shortly after, so the
 *                connection dies inside the initialize window.
 *  - exit:       closes the connection on the prompt request.
 */
const MOCK_SCRIPT = `
const readline = require('readline');
const mode = process.env.MOCK_MODE || 'stream';
const rl = readline.createInterface({ input: process.stdin });
let pendingPrompt = null;
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
const hardTimeout = setTimeout(() => {
  answerPrompt({ stopReason:'cancelled', usage:{ totalTokens:1, inputTokens:1, outputTokens:0 } });
  setTimeout(() => process.exit(0), 50);
}, 2000);
rl.on('line', (line) => {
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
        agentCapabilities: {},
        agentInfo: { name: 'mock-agent', version: '1.0.0' },
      }});
      break;
    case 'session/new':
      send({ jsonrpc:'2.0', id, result: { sessionId: 'sess-1' } });
      if (mode === 'stream' || mode === 'cancel') {
        sendUpdate('sess-1', 'hello ');
      }
      if (mode === 'stream') {
        sendUpdate('sess-1', 'world');
      }
      break;
    case 'session/prompt':
      pendingPrompt = { id };
      if (mode === 'stream') {
        answerPrompt({ stopReason:'end_turn', usage:{ totalTokens:42, inputTokens:10, outputTokens:32 } });
      } else if (mode === 'exit') {
        process.exit(0);
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
});
`;

function spawnSpec(mode: string): AcpSpawnSpec {
  return { command: process.execPath, args: ["-e", MOCK_SCRIPT] };
}

function env(mode: string): Record<string, string> {
  return { MOCK_MODE: mode, PATH: process.env.PATH ?? "" };
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

    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/Failed to spawn ACP agent/);
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

    expect(err).toBeInstanceOf(Error);
  });
});
