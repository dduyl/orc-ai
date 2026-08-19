import { describe, it, expect, afterEach } from "vitest";
import {
  AcpPtyFacade,
  acpEnabledFor,
  callAcpAgentStream,
  ACP_ENABLED_ENV,
} from "../../../../application/agents/adapter-acp.js";
import { registerAcpStrategy, getAcpStrategy, registerStrategy } from "../../../../application/agents/strategy.js";
import { callAgentStream } from "../../../../application/agents/adapter-pty.js";
import type { AdapterDef } from "../../../../application/agents/adapter.js";
import type { AcpStrategy } from "../../../../application/agents/acp/types.js";
import { AgentCallError } from "../../../../application/agents/errors.js";
import {
  createHookFile,
  removeHookFile,
  readHookEvents,
  stepIdFromHookFile,
} from "../../../../adapters/hooks/endpoint.js";

const MOCK_SCRIPT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const { id, method } = msg;
  if (method === 'initialize') {
    send({ jsonrpc:'2.0', id, result:{ protocolVersion:1, agentCapabilities:{}, agentInfo:{ name:'mock', version:'1' } } });
  } else if (method === 'session/new') {
    send({ jsonrpc:'2.0', id, result:{ sessionId:'sess-1' } });
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:'sess-1', update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text:'mock reply' } } } });
  } else if (method === 'session/prompt') {
    send({ jsonrpc:'2.0', id, result:{ stopReason:'end_turn', usage:{ totalTokens:7, inputTokens:2, outputTokens:5 } } });
  }
});
`;

const MOCK_SCRIPT_WITH_TOOL = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const { id, method } = msg;
  if (method === 'initialize') {
    send({ jsonrpc:'2.0', id, result:{ protocolVersion:1, agentCapabilities:{}, agentInfo:{ name:'mock', version:'1' } } });
  } else if (method === 'session/new') {
    send({ jsonrpc:'2.0', id, result:{ sessionId:'sess-1' } });
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:'sess-1', update:{ sessionUpdate:'agent_message_chunk', content:{ type:'text', text:'mock reply' } } } });
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:'sess-1', update:{ sessionUpdate:'tool_call', toolCallId:'tc-1', title:'Mock Write', name:'write_file', kind:'edit', status:'in_progress', locations:[{ path:'/tmp/mock.txt', line:1 }], rawInput:{ path:'/tmp/mock.txt' } } } });
  } else if (method === 'session/prompt') {
    send({ jsonrpc:'2.0', id, result:{ stopReason:'end_turn', usage:{ totalTokens:7, inputTokens:2, outputTokens:5 } } });
  }
});
`;

const MOCK_SCRIPT_QUOTA = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const { id, method } = msg;
  if (method === 'initialize') {
    send({ jsonrpc:'2.0', id, result:{ protocolVersion:1, agentCapabilities:{}, agentInfo:{ name:'mock', version:'1' } } });
  } else if (method === 'session/new') {
    send({ jsonrpc:'2.0', id, result:{ sessionId:'sess-1' } });
  } else if (method === 'session/prompt') {
    send({ jsonrpc:'2.0', id, error:{ code:-32000, message:'You exceeded your current quota, please check your plan and billing details.' } });
  }
});
`;

const origEnv = { ...process.env };

afterEach(() => {
  process.env = { ...origEnv };
});

function fakeAcpStrategy(id: string, available = true): AcpStrategy {
  return {
    id,
    available,
    label: "mock-acp",
    buildSpawn: () => ({ command: process.execPath, args: ["-e", MOCK_SCRIPT] }),
  };
}

function fakeAcpStrategyWithTool(id: string): AcpStrategy {
  return {
    id,
    available: true,
    label: "mock-acp",
    buildSpawn: () => ({ command: process.execPath, args: ["-e", MOCK_SCRIPT_WITH_TOOL] }),
  };
}

function fakeAcpStrategyQuota(id: string): AcpStrategy {
  return {
    id,
    available: true,
    label: "mock-acp",
    buildSpawn: () => ({ command: process.execPath, args: ["-e", MOCK_SCRIPT_QUOTA] }),
  };
}

const ADAPTER: AdapterDef = { id: "acp-test-agent", command: "ignored", label: "ACP Test Agent" };

describe("AcpPtyFacade", () => {
  it("satisfies the IPty duck shape", () => {
    const facade = new AcpPtyFacade();
    expect(typeof facade.onData).toBe("function");
    expect(typeof facade.onExit).toBe("function");
    expect(typeof facade.write).toBe("function");
    expect(typeof facade.kill).toBe("function");
    expect(typeof facade.resize).toBe("function");
    expect(typeof facade.clear).toBe("function");
    expect(typeof facade.pause).toBe("function");
    expect(typeof facade.resume).toBe("function");
    expect(typeof facade.pid).toBe("number");
    expect(facade.cols).toBe(120);
    expect(facade.rows).toBe(40);
  });

  it("aborts its signal on kill", () => {
    const facade = new AcpPtyFacade();
    expect(facade.aborted).toBe(false);
    facade.kill();
    expect(facade.aborted).toBe(true);
    // kill is idempotent
    facade.kill();
  });

  it("forwards text chunks to onData subscribers", () => {
    const facade = new AcpPtyFacade();
    const seen: string[] = [];
    facade.onData(text => seen.push(text));
    facade.feed("a");
    facade.feed("b");
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("default ACP strategy seeding", () => {
  it("registers the built-in opencode and claude ACP strategies at module load", () => {
    expect(getAcpStrategy("opencode")).toBeDefined();
    expect(getAcpStrategy("claude")).toBeDefined();
  });
});

describe("acpEnabledFor", () => {
  it("is false without ORC_ACP_ENABLED", () => {
    delete process.env[ACP_ENABLED_ENV];
    expect(acpEnabledFor("acp-test-agent")).toBe(false);
  });

  it("is false when no ACP strategy is registered", () => {
    process.env[ACP_ENABLED_ENV] = "1";
    expect(acpEnabledFor("no-such-agent")).toBe(false);
  });

  it("is true when enabled and the strategy is available", () => {
    registerAcpStrategy(fakeAcpStrategy("acp-test-agent"));
    process.env[ACP_ENABLED_ENV] = "1";
    expect(acpEnabledFor("acp-test-agent")).toBe(true);
  });

  it("is false when the strategy probe failed", () => {
    registerAcpStrategy(fakeAcpStrategy("acp-unavailable", false));
    process.env[ACP_ENABLED_ENV] = "1";
    expect(acpEnabledFor("acp-unavailable")).toBe(false);
  });
});

describe("callAcpAgentStream", () => {
  it("runs a turn and surfaces content + usage through the facade", async () => {
    registerAcpStrategy(fakeAcpStrategy("acp-test-agent"));
    const handle = callAcpAgentStream(ADAPTER, "hello");

    const chunks: string[] = [];
    handle.pty.onData(text => chunks.push(text));

    const result = await handle.promise;
    expect(result.content).toBe("mock reply");
    expect(result.tokensUsed).toBe(7);
    expect(result.usage).toMatchObject({ totalTokens: 7, inputTokens: 2, outputTokens: 5 });
    expect(result.model).toBe("acp-test-agent");
    expect(chunks.join("")).toBe("mock reply");
  });

  it("throws an actionable error when the strategy is unavailable", () => {
    registerAcpStrategy(fakeAcpStrategy("acp-unavailable", false));
    expect(() => callAcpAgentStream(
      { ...ADAPTER, id: "acp-unavailable" },
      "hello",
    )).toThrow(/unavailable/);
  });

  it("rejects with the classified quota AgentCallError (kind survives the whole chain)", async () => {
    registerAcpStrategy(fakeAcpStrategyQuota("acp-test-agent"));
    const handle = callAcpAgentStream(ADAPTER, "hello");
    const err = await handle.promise.then(
      () => null,
      e => e,
    );

    expect(err).toBeInstanceOf(AgentCallError);
    expect((err as AgentCallError).kind).toBe("quota");
    expect((err as AgentCallError).message).toMatch(/quota/);
  });

  it("feeds rendered tool-call lines through the facade", async () => {
    registerAcpStrategy(fakeAcpStrategyWithTool("acp-test-agent"));
    const handle = callAcpAgentStream(ADAPTER, "hello");

    const chunks: string[] = [];
    handle.pty.onData(text => chunks.push(text));
    await handle.promise;

    const fed = chunks.join("");
    expect(fed).toContain("→ Mock Write [in_progress]");
    expect(fed).toContain("    at /tmp/mock.txt:1");
  });

  it("writes tool_call and step_finish events to the hook file (Tracker observability)", async () => {
    registerAcpStrategy(fakeAcpStrategyWithTool("acp-test-agent"));
    const hookFile = createHookFile("step-acp-test");
    try {
      const handle = callAcpAgentStream(ADAPTER, "hello", hookFile);
      await handle.promise;

      const events = readHookEvents(hookFile);
      const toolCall = events.find(e => e.type === "tool_call");
      expect(toolCall).toMatchObject({
        type: "tool_call",
        stepId: "step-acp-test",
        tool: "write_file",
      });
      expect((toolCall as { input: string }).input).toContain('"path":"/tmp/mock.txt"');

      const finish = events.find(e => e.type === "step_finish");
      expect(finish).toMatchObject({
        type: "step_finish",
        stepId: "step-acp-test",
        reason: "end_turn",
        tokens: { total: 7, input: 2, output: 5 },
      });
    } finally {
      removeHookFile(hookFile);
    }
  });

  it("writes a quota step_finish hook event carrying the structured quota payload", async () => {
    registerAcpStrategy(fakeAcpStrategyQuota("acp-test-agent"));
    const hookFile = createHookFile("step-acp-quota");
    try {
      const handle = callAcpAgentStream(ADAPTER, "hello", hookFile);
      await handle.promise.then(
        () => null,
        e => e,
      );

      const events = readHookEvents(hookFile);
      const finish = events.find(e => e.type === "step_finish");
      expect(finish).toMatchObject({
        type: "step_finish",
        stepId: "step-acp-quota",
        reason: "quota",
      });
      expect((finish as { quota?: { kind: string; message: string } }).quota).toEqual({
        kind: "quota",
        message: "You exceeded your current quota, please check your plan and billing details.",
      });
    } finally {
      removeHookFile(hookFile);
    }
  });
});

describe("stepIdFromHookFile", () => {
  it("round-trips the stepId from a createHookFile path", () => {
    const hookFile = createHookFile("step-42");
    try {
      expect(stepIdFromHookFile(hookFile)).toBe("step-42");
    } finally {
      removeHookFile(hookFile);
    }
  });

  it("returns 'unknown' for paths that don't match the format", () => {
    expect(stepIdFromHookFile("C:\\tmp\\unrelated\\events.jsonl")).toBe("unknown");
  });
});

describe("dispatch shim", () => {
  it("routes callAgentStream through ACP when enabled", async () => {
    registerAcpStrategy(fakeAcpStrategy("acp-test-agent"));
    process.env[ACP_ENABLED_ENV] = "1";
    const handle = callAgentStream(ADAPTER, "hello");
    expect(handle.pty).toBeInstanceOf(AcpPtyFacade);
    const result = await handle.promise;
    expect(result.content).toBe("mock reply");
  });

  it("keeps the PTY path when ACP is not enabled", () => {
    registerStrategy({
      id: "mock-pty-agent",
      buildArgs: () => [],
      keepAlive: false,
      isComplete: () => false,
      extractOutput: (out: string) => out,
    });
    delete process.env[ACP_ENABLED_ENV];
    const handle = callAgentStream(
      {
        id: "mock-pty-agent",
        command: process.platform === "win32" ? "cmd.exe" : "echo",
        label: "Mock PTY",
      },
      "hello",
    );
    expect(handle.pty).not.toBeInstanceOf(AcpPtyFacade);
    handle.promise.catch(() => {});
  });
});
