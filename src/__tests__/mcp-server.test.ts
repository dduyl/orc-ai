import { describe, it, expect, vi, beforeAll } from "vitest";
import { McpServer } from "../mcp/server.js";
import { WorkflowRegistry } from "../planner/registry.js";
import { registerStrategy } from "../agents/strategy.js";
import type { AdapterDef } from "../agents/adapter.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const echoAdapter: AdapterDef = { id: "echo", command: "cmd", label: "Echo" };

beforeAll(() => {
  registerStrategy({
    id: "echo",
    buildArgs: () => ["/c", "echo", "test-output"],
    keepAlive: false,
    isComplete: () => false,
    extractOutput: (s: string) => s.trim(),
  });
});

function tmpReg(...files: { name: string; data: any }[]): WorkflowRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-mcp-"));
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f.name), JSON.stringify(f.data));
  }
  const reg = new WorkflowRegistry(dir);
  reg.loadAll();
  return reg;
}

function makeServer(reg?: WorkflowRegistry): McpServer {
  return new McpServer(echoAdapter, reg || tmpReg());
}

describe("MCP Server — handle() request routing", () => {
  it("responds to initialize with protocolVersion", async () => {
    const server = makeServer();
    const res = await (server as any).handle({
      jsonrpc: "2.0", id: 1, method: "initialize",
    });

    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.error).toBeUndefined();
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.serverInfo.name).toBe("orc-server");
  });

  it("responds to tools/list with all 8 tools", async () => {
    const server = makeServer();
    const res = await (server as any).handle({
      jsonrpc: "2.0", id: 2, method: "tools/list",
    });

    expect(res.result.tools).toBeInstanceOf(Array);
    expect(res.result.tools.length).toBe(8);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("guide");
    expect(names).toContain("list_workflows");
    expect(names).toContain("list_prompts");
    expect(names).toContain("create_workflow");
    expect(names).toContain("run_workflow");
    expect(names).toContain("get_run_status");
    expect(names).toContain("list_runs");
    expect(names).toContain("return_result");
  });

  it("responds to resources/list with orc://guide", async () => {
    const server = makeServer();
    const res = await (server as any).handle({
      jsonrpc: "2.0", id: 3, method: "resources/list",
    });

    expect(res.result.resources).toBeInstanceOf(Array);
    expect(res.result.resources[0].uri).toBe("orc://guide");
  });

  it("responds to resources/read with guide text", async () => {
    const server = makeServer();
    const res = await (server as any).handle({
      jsonrpc: "2.0", id: 4, method: "resources/read",
      params: { uri: "orc://guide" },
    });

    expect(res.result.contents[0].uri).toBe("orc://guide");
    expect(res.result.contents[0].mimeType).toBe("text/markdown");
    expect(res.result.contents[0].text).toContain("list_workflows");
    expect(res.result.contents[0].text).toContain("run_workflow");
  });

  it("guide tool returns guide text", async () => {
    const server = makeServer();
    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "guide", arguments: {} },
    });

    expect(res.result.content[0].text).toContain("list_workflows");
    expect(res.result.content[0].text).toContain("run_workflow");
  });

  it("guide tool with task appends user task", async () => {
    const server = makeServer();
    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 12, method: "tools/call",
      params: { name: "guide", arguments: { task: "build a landing page" } },
    });

    expect(res.result.content[0].text).toContain("list_workflows");
    expect(res.result.content[0].text).toContain("build a landing page");
  });

  it("returns -32601 for unknown method", async () => {
    const server = makeServer();
    const res = await (server as any).handle({
      jsonrpc: "2.0", id: 6, method: "foobar",
    });

    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toBe("Method not found");
  });

  it("uses listTools as alias for tools/list", async () => {
    const server = makeServer();
    const res = await (server as any).handle({
      jsonrpc: "2.0", id: 7, method: "listTools",
    });

    expect(res.result.tools).toBeInstanceOf(Array);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain("guide");
    expect(names).toContain("list_workflows");
    expect(names).toContain("list_prompts");
    expect(names).toContain("create_workflow");
    expect(names).toContain("run_workflow");
  });

  it("uses listResources as alias for resources/list", async () => {
    const server = makeServer();
    const res = await (server as any).handle({
      jsonrpc: "2.0", id: 9, method: "listResources",
    });

    expect(res.result.resources).toBeInstanceOf(Array);
    expect(res.result.resources[0].uri).toBe("orc://guide");
  });

  it("uses readResource as alias for resources/read", async () => {
    const server = makeServer();
    const res = await (server as any).handle({
      jsonrpc: "2.0", id: 10, method: "readResource",
      params: { uri: "orc://guide" },
    });

    expect(res.result.contents[0].uri).toBe("orc://guide");
  });
});

describe("MCP Server — handleToolCall() tool execution", () => {
  it("list_workflows returns workflow list from registry", async () => {
    const reg = tmpReg({ name: "custom.json", data: { version: 1, workflow: { id: "my_wf", name: "My WF", description: "Test workflow", steps: [{ id: "s1", agent: "requirement_analyst", task: "a", depends_on: [] }], completion: "Done" } } });
    const server = makeServer(reg);
    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 20, method: "tools/call",
      params: { name: "list_workflows", arguments: {} },
    });

    expect(res.error).toBeUndefined();
    const list = JSON.parse(res.result.content[0].text);
    expect(Array.isArray(list)).toBe(true);
    const wf = list.find((w: any) => w.id === "my_wf");
    expect(wf).toBeDefined();
    expect(wf.description).toBe("Test workflow");
    expect(Array.isArray(wf.steps)).toBe(true);
    expect(wf.steps[0].id).toBe("s1");
    expect(wf.steps[0].agent).toBe("requirement_analyst");
  });

  it("list_prompts returns built-in agents", async () => {
    const server = makeServer();
    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 21, method: "tools/call",
      params: { name: "list_prompts", arguments: {} },
    });

    expect(res.error).toBeUndefined();
    const agents = JSON.parse(res.result.content[0].text);
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(7);
    const names = agents.map((a: any) => a.name);
    expect(names).toContain("requirement_analyst");
    expect(names).toContain("code_generation_backend");
    expect(names).toContain("code_generation_frontend");
    expect(names).toContain("test_generation_backend");
    expect(names).toContain("test_generation_frontend");
    expect(names).toContain("review");
    agents.forEach((a: any) => {
      expect(a.description).toBeTruthy();
    });
  });

  it("create_workflow saves and returns new workflow", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-mcp-wf-"));
    const reg = new WorkflowRegistry(dir);
    const server = makeServer(reg);

    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 22, method: "tools/call",
      params: {
        name: "create_workflow",
        arguments: {
          id: "my_new_wf",
          name: "My New Workflow",
          description: "A custom workflow for testing",
          steps: [
            { id: "s1", agent: "requirement_analyst", task: "analyze", depends_on: [] },
            { id: "s2", agent: "code_generation_backend", task: "code", depends_on: ["s1"] },
          ],
          completion: "All done",
        },
      },
    });

    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.id).toBe("my_new_wf");
    expect(body.name).toBe("My New Workflow");
    expect(body.status).toBe("created");

    // Verify it was saved to disk
    const savedPath = path.join(dir, "my_new_wf.json");
    expect(fs.existsSync(savedPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(savedPath, "utf-8"));
    expect(saved.workflow.id).toBe("my_new_wf");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("create_workflow returns -32602 when required fields missing", async () => {
    const server = makeServer();
    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 23, method: "tools/call",
      params: {
        name: "create_workflow",
        arguments: { id: "x", name: "y" },
      },
    });

    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
  });

  it("run_workflow with workflowId returns completed status", { timeout: 30000 }, async () => {
    const reg = tmpReg({ name: "existing.json", data: { version: 1, workflow: { id: "existing_wf", name: "Existing", steps: [{ id: "s1", agent: "requirement_analyst", task: "a", depends_on: [] }], completion: "Done" } } });
    const server = new McpServer(echoAdapter, reg);
    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 24, method: "tools/call",
      params: { name: "run_workflow", arguments: { task: "do it", workflowId: "existing_wf" } },
    });

    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.workflowId).toBe("existing_wf");
    expect(body.status).toBe("completed");
  });

  it("run_workflow with workflowId unknown returns error", async () => {
    const reg = tmpReg();
    const server = makeServer(reg);
    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 25, method: "tools/call",
      params: { name: "run_workflow", arguments: { task: "do it", workflowId: "nope" } },
    });

    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("Unknown workflowId");
  });

  it("run_workflow returns -32602 when task argument is missing", async () => {
    const server = makeServer();
    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 26, method: "tools/call",
      params: { name: "run_workflow", arguments: {} },
    });

    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("task");
  });

  it("run_workflow returns -32602 when workflowId argument is missing", async () => {
    const server = makeServer();
    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 27, method: "tools/call",
      params: { name: "run_workflow", arguments: { task: "do it" } },
    });

    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("workflowId");
  });

  it("returns -32601 for unknown tool name", async () => {
    const server = makeServer();
    const res = await (server as any).handleToolCall({
      jsonrpc: "2.0", id: 28, method: "tools/call",
      params: { name: "unknown_tool", arguments: { task: "x" } },
    });

    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toContain("Unknown tool");
  });
});

describe("MCP Server — HTTP SSE streaming", () => {
  it("run_workflow streams progress via HTTP SSE", { timeout: 30000 }, async () => {
    const reg = tmpReg({ name: "sse_wf.json", data: { version: 1, workflow: { id: "sse_wf", name: "SSE Test Workflow", steps: [{ id: "s1", agent: "requirement_analyst", task: "analyze requirements", depends_on: [] }], completion: "Done" } } });
    const server = new McpServer(echoAdapter, reg);
    await server.startHttp(0);
    const addr = server.getHttpServer()!.address() as any;
    const port = addr.port;

    try {
      const sessionId = await initSession(port);
      expect(sessionId).toBeTruthy();

      const runRes = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "run_workflow", arguments: { task: "do it", workflowId: "sse_wf" } },
        }),
      });

      expect(runRes.status).toBe(200);
      const ctype = runRes.headers.get("content-type") || "";
      expect(ctype).toMatch(/text\/event-stream/);

      const raw = await runRes.text();
      expect(raw.length).toBeGreaterThan(0);

      let foundProgress = false;
      let foundResult = false;

      for (const block of raw.split(/\n\n+/).filter(Boolean)) {
        const trimmed = block.trim();
        for (const line of trimmed.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json) continue;
          const msg = JSON.parse(json);
          if (msg.method === "notifications/progress") {
            foundProgress = true;
          }
          if (msg.id === 2 && msg.result) {
            foundResult = true;
            const payload = JSON.parse(msg.result.content[0].text);
            expect(payload.workflowId).toBe("sse_wf");
            expect(payload.status).toBe("completed");
          }
        }
      }

      expect(foundProgress).toBe(true);
      expect(foundResult).toBe(true);
    } finally {
      server.getHttpServer()?.close();
    }
  });
});

async function initSession(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    }),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  // Response is SSE — extract JSON from data: field
  const raw = await res.text();
  const match = raw.match(/data:\s*(\{.*\})\s*\n/);
  expect(match).toBeTruthy();
  const body = JSON.parse(match![1]);
  expect(body.result.serverInfo.name).toBe("orc-server");
  return sid!;
}


