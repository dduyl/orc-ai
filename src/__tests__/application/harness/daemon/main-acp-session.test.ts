import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { MainAcpSession } from "../../../../application/harness/daemon/main-acp-session.js";
import { decodeMainFrame, type MainFrame } from "../../../../application/harness/daemon/main-frame-codec.js";
import type { PermissionRequest } from "../../../../application/agents/acp/permission.js";
import { connect, collectFrames, flushUntil, listen, sleep } from "./helpers.js";

/** JSON-RPC agent mock: initialize, session/new (emits one text chunk), prompt. */
const MOCK_AGENT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg){ process.stdout.write(JSON.stringify(msg) + '\\n'); }
let nextId = 1000;
const pending = {};
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id && pending[msg.id]) {
    pending[msg.id](msg.result);
    delete pending[msg.id];
    return;
  }
  const { id, method } = msg;
  if (method === 'initialize') {
    send({ jsonrpc:'2.0', id, result:{ protocolVersion:1, agentCapabilities:{}, agentInfo:{ name:'mock', version:'1' } } });
  } else if (method === 'session/new') {
    const result = { sessionId:'sess-1' };
    if (process.env.REQ_CONFIG === '1') {
      result.configOptions = [
        { id:'model', name:'Model', category:'model', type:'select', currentValue:'mini',
          options:[{ value:'mini', name:'opencode mini' }, { value:'full', name:'opencode' }] }
      ];
    }
    send({ jsonrpc:'2.0', id, result });
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:'sess-1', update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text:'mock reply' } } } });
    if (process.env.REQ_CMDS_AT_OPEN === '1') {
      send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:'sess-1', update:{ sessionUpdate:'available_commands_update', availableCommands:[
        { name:'compact', description:'Compact history' },
        { name:'help', description:'Get help', input:{ hint:'<topic>' } }
      ] } } });
    }
  } else if (method === 'session/prompt') {
    if (process.env.REQ_CMDS === '1') {
      send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:'sess-1', update:{ sessionUpdate:'available_commands_update', availableCommands:[
        { name:'compact', description:'Compact history' },
        { name:'help', description:'Get help', input:{ hint:'<topic>' } }
      ] } } });
    }
    if (process.env.REQ_CFG_UPDATE === '1') {
      send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:'sess-1', update:{ sessionUpdate:'config_option_update', configOptions:[
        { id:'model', name:'Model', category:'model', type:'select', currentValue:'full',
          options:[{ value:'mini', name:'opencode mini' }, { value:'full', name:'opencode' }] }
      ] } } });
    }
    if (process.env.REQ_ERROR === '1') {
      send({ jsonrpc:'2.0', id, error:{ code:-32000, message:'mock turn failure' } });
    } else if (process.env.REQ_PERM === '1') {
      const permId = nextId++;
      pending[permId] = () => {
        send({ jsonrpc:'2.0', id, result:{ stopReason:'end_turn', usage:{ totalTokens:7, inputTokens:2, outputTokens:5 } } });
      };
      send({ jsonrpc:'2.0', id: permId, method:'session/request_permission', params:{
        sessionId:'sess-1',
        toolCall:{ toolCallId:'tc-1', title:'Run tests', name:'run_tests', status:'in_progress' },
        options:[
          { optionId:'o1', kind:'allow_once', name:'Allow once' },
          { optionId:'o2', kind:'allow_always', name:'Always allow' },
          { optionId:'o3', kind:'reject_once', name:'Reject' },
        ],
      } });
    } else if (process.env.REQ_ECHO === '1') {
      send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:'sess-1', update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text: JSON.stringify(msg.params.prompt) } } } });
      send({ jsonrpc:'2.0', id, result:{ stopReason:'end_turn', usage:{ totalTokens:7, inputTokens:2, outputTokens:5 } } });
    } else {
      send({ jsonrpc:'2.0', id, result:{ stopReason:'end_turn', usage:{ totalTokens:7, inputTokens:2, outputTokens:5 } } });
    }
  } else if (method === 'session/set_config_option') {
    const value = (msg.params && msg.params.value) || 'mini';
    const configOptions = [
      { id:'model', name:'Model', category:'model', type:'select', currentValue: value,
        options:[{ value:'mini', name:'opencode mini' }, { value:'full', name:'opencode' }] }
    ];
    send({ jsonrpc:'2.0', id, result:{ configOptions } });
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:'sess-1', update:{ sessionUpdate:'config_option_update', configOptions } } });
  }
});
`;

function makeSession(opts: { onPermission?: (r: PermissionRequest) => void } = {}): MainAcpSession {
  return new MainAcpSession({
    cwd: process.cwd(),
    spawn: { command: process.execPath, args: ["-e", MOCK_AGENT] },
    env: { ...(process.env as Record<string, string>) },
    onPermission: opts.onPermission,
  });
}

/** Attach a fresh socket to the session; returns decoded frames + EOF. */
async function attachTo(session: MainAcpSession): Promise<{
  sock: net.Socket;
  server: net.Server;
  frames: Buffer[];
  eof: Promise<void>;
}> {
  const { server, port } = await listen((sock) => session.attach(sock));
  const sock = await connect(port);
  const coll = collectFrames(sock);
  return { sock, server, frames: coll.frames, eof: coll.eof };
}

function decoded(frames: Buffer[]): MainFrame[] {
  return frames.map((b) => decodeMainFrame(b));
}

const sessions: MainAcpSession[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const s of sessions) s.close();
  sessions.length = 0;
  for (const srv of servers) {
    try {
      srv.close();
    } catch {
      /* ignore */
    }
  }
  servers.length = 0;
  await sleep(20);
  delete process.env["REQ_PERM"];
  delete process.env["REQ_ERROR"];
  delete process.env["REQ_ECHO"];
  delete process.env["REQ_CMDS"];
  delete process.env["REQ_CMDS_AT_OPEN"];
  delete process.env["REQ_CFG_UPDATE"];
  delete process.env["REQ_CONFIG"];
});

describe("MainAcpSession", () => {
  it("drives a prompt turn into main frames over an attached socket", async () => {
    const session = makeSession();
    sessions.push(session);
    const boot = session.start();

    const { frames, server } = await attachTo(session);
    servers.push(server);

    session.prompt("hello");
    await flushUntil(() => frames.length >= 2);

    const got = decoded(frames);
    expect(got.find((f) => f.kind === "text")).toMatchObject({ kind: "text", text: "mock reply" });
    expect(got.find((f) => f.kind === "turn")).toMatchObject({ kind: "turn", stopReason: "end_turn" });
    expect(got.find((f) => f.kind === "usage")).toMatchObject({
      kind: "usage",
      usage: { totalTokens: 7, inputTokens: 2, outputTokens: 5 },
    });
    expect(session.session).toBe("sess-1");

    session.close();
    await boot;
  });

  it("forwards permission requests and answers them via answerPermission", async () => {
    process.env["REQ_PERM"] = "1";
    const seen: PermissionRequest[] = [];
    const session = makeSession({ onPermission: (r) => seen.push(r) });
    sessions.push(session);
    const boot = session.start();

    const { frames, server } = await attachTo(session);
    servers.push(server);

    session.prompt("run tests");
    await flushUntil(() => seen.length > 0);

    expect(seen[0].toolCall.title).toBe("Run tests");
    expect(seen[0].options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    // answer the exact request that was surfaced (by correlation id)
    expect(session.answerPermission(seen[0].requestId, "allow_once")).toBe(true);
    // an answer for a stale / unknown request is a no-op
    expect(session.answerPermission(seen[0].requestId, "reject_once")).toBe(false);
    expect(session.answerPermission("perm-does-not-exist", "allow_once")).toBe(false);

    await flushUntil(() => decoded(frames).some((f) => f.kind === "turn"));
    expect(decoded(frames).find((f) => f.kind === "turn")).toMatchObject({ kind: "turn", stopReason: "end_turn" });

    session.close();
    await boot;
  });

  it("replays buffered frames to a late client", async () => {
    const session = makeSession();
    sessions.push(session);
    const boot = session.start();

    const first = await attachTo(session);
    servers.push(first.server);
    session.prompt("hello");
    await flushUntil(() => decoded(first.frames).some((f) => f.kind === "turn"));
    first.sock.destroy();

    // A brand-new client gets the full replay, including the finished turn.
    const second = await attachTo(session);
    servers.push(second.server);
    await flushUntil(() => decoded(second.frames).some((f) => f.kind === "turn"));
    const got = decoded(second.frames);
    expect(got.find((f) => f.kind === "text")).toMatchObject({ kind: "text", text: "mock reply" });
    expect(got.find((f) => f.kind === "turn")).toMatchObject({ kind: "turn", stopReason: "end_turn" });

    session.close();
    await boot;
  });

  it("closes the turn sequence when a prompt turn fails", async () => {
    process.env["REQ_ERROR"] = "1";
    const session = makeSession();
    sessions.push(session);
    const boot = session.start();

    const { frames, server } = await attachTo(session);
    servers.push(server);

    session.prompt("will fail");
    await flushUntil(() => decoded(frames).some((f) => f.kind === "error"));

    const got = decoded(frames);
    expect(got.find((f) => f.kind === "error")).toMatchObject({
      kind: "error",
      message: expect.stringContaining("mock turn failure"),
    });
    // The error frame is followed by a `turn` frame so the chat closes the
    // turn sequence (divider + counter) instead of stalling on the error.
    expect(got.find((f) => f.kind === "turn")).toMatchObject({
      kind: "turn",
      stopReason: "error",
    });

    session.close();
    await boot;
  });

  it("prompt turns with mentions send the text plus a resource_link block per mention", async () => {
    process.env["REQ_ECHO"] = "1";
    const session = makeSession();
    sessions.push(session);
    const boot = session.start();

    const { frames, server } = await attachTo(session);
    servers.push(server);

    session.prompt("review this", [{ path: "src/core/types.ts" }, { path: "src/index.ts" }]);
    await flushUntil(() => decoded(frames).filter((f) => f.kind === "text").length >= 2);

    const got = decoded(frames);
    const texts = got.filter((f) => f.kind === "text");
    const text = texts[texts.length - 1] as { text: string } | undefined;
    expect(text).toBeTruthy();
    const sent = JSON.parse(text!.text) as Array<{
      type: string;
      text?: string;
      name?: string;
      uri?: string;
    }>;
    expect(sent[0]).toEqual({ type: "text", text: "review this" });
    const links = sent.filter((b) => b.type === "resource_link");
    expect(links).toHaveLength(2);
    expect(links[0].name).toBe("src/core/types.ts");
    expect(links[0].uri).toContain("file:///");
    expect(links[0].uri).toContain("src/core/types.ts");
    expect(links[1].name).toBe("src/index.ts");

    session.close();
    await boot;
  });

  it("EOFs attached clients and resolves start() on close", async () => {
    const session = makeSession();
    sessions.push(session);
    const boot = session.start();

    const { eof, server } = await attachTo(session);
    servers.push(server);

    session.close();
    await eof;
    await boot;
    expect(session.exited).toBe(true);
  });

  it("emits a config frame from session/new configOptions", async () => {
    process.env["REQ_CONFIG"] = "1";
    const session = makeSession();
    sessions.push(session);
    const boot = session.start();

    const { frames, server } = await attachTo(session);
    servers.push(server);
    await flushUntil(() => decoded(frames).some((f) => f.kind === "config"));

    expect(decoded(frames).find((f) => f.kind === "config")).toMatchObject({
      kind: "config",
      options: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "mini",
          options: [
            { value: "mini", name: "opencode mini" },
            { value: "full", name: "opencode" },
          ],
        },
      ],
    });

    session.close();
    await boot;
  });

  it("forwards available_commands_update into a commands frame", async () => {
    process.env["REQ_CMDS"] = "1";
    const session = makeSession();
    sessions.push(session);
    const boot = session.start();

    const { frames, server } = await attachTo(session);
    servers.push(server);

    session.prompt("hello");
    await flushUntil(() => decoded(frames).some((f) => f.kind === "commands"));

    expect(decoded(frames).find((f) => f.kind === "commands")).toMatchObject({
      kind: "commands",
      commands: [
        { name: "compact", description: "Compact history" },
        { name: "help", description: "Get help", input: "<topic>" },
      ],
    });

    session.close();
    await boot;
  });

  it("drains session-open updates (available_commands_update) before any prompt", async () => {
    process.env["REQ_CMDS_AT_OPEN"] = "1";
    const session = makeSession();
    sessions.push(session);
    const boot = session.start();

    const { frames, server } = await attachTo(session);
    servers.push(server);

    // No prompt is submitted: the commands frame must arrive from the
    // session-open drain, proving `/` works before the user's first turn.
    await flushUntil(() => decoded(frames).some((f) => f.kind === "commands"));

    expect(decoded(frames).find((f) => f.kind === "commands")).toMatchObject({
      kind: "commands",
      commands: [
        { name: "compact", description: "Compact history" },
        { name: "help", description: "Get help", input: "<topic>" },
      ],
    });

    session.close();
    await boot;
  });

  it("forwards config_option_update into a config frame", async () => {
    process.env["REQ_CFG_UPDATE"] = "1";
    const session = makeSession();
    sessions.push(session);
    const boot = session.start();

    const { frames, server } = await attachTo(session);
    servers.push(server);

    session.prompt("hello");
    await flushUntil(() => decoded(frames).some((f) => f.kind === "config"));

    expect(decoded(frames).find((f) => f.kind === "config")).toMatchObject({
      kind: "config",
      options: [{ id: "model", currentValue: "full" }],
    });

    session.close();
    await boot;
  });

  it("setConfigOption sends session/set_config_option and re-emits config", async () => {
    const session = makeSession();
    sessions.push(session);
    const boot = session.start();

    const { frames, server } = await attachTo(session);
    servers.push(server);
    await flushUntil(() => session.session !== null);

    await session.setConfigOption("model", "full");
    await flushUntil(() => decoded(frames).some((f) => f.kind === "config"));

    expect(decoded(frames).find((f) => f.kind === "config")).toMatchObject({
      kind: "config",
      options: [{ id: "model", currentValue: "full" }],
    });

    session.close();
    await boot;
  });
});
