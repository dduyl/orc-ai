import { describe, it, expect, beforeEach } from "vitest";
import type { TextContent } from "@modelcontextprotocol/sdk/types";

function textOf(result: { content: any[] }): string {
  return (result.content[0] as TextContent).text;
}
import * as os from "node:os";
import * as path from "node:path";
import { ErrorCode } from "@modelcontextprotocol/sdk/types";
import {
  TOOL_HANDLERS,
  executeTool,
} from "../../../adapters/mcp/sdk-server-factory.js";
import {
  handleGetRunStatusTool,
  handleListRunsTool,
  handleListWorkflowsTool,
} from "../../../adapters/mcp/handlers/workflow-handlers.js";
import { handleGuideTool, handleReturnResult } from "../../../adapters/mcp/handlers/result-handlers.js";
import { handleListTools } from "../../../adapters/mcp/handlers/capabilities.js";
import { init as initState } from "../../../adapters/mcp/handlers/state.js";
import { RunHost } from "../../../application/harness/run-host.js";
import type { AdapterDef } from "../../../application/agents/adapter.js";
import type { RunHandlerExtra } from "../../../adapters/mcp/handlers/workflow-handlers.js";
import { Tracker } from "../../../application/harness/persistence/Tracker.js";

const FAKE_EXTRA: RunHandlerExtra = {
  sendNotification: async () => {},
  signal: new AbortController().signal,
};

function tmpDir(label: string): string {
  return path.join(os.tmpdir(), `orc-sdk-dispatch-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("MCP SDK dispatch", () => {
  let tracker: Tracker;

  beforeEach(() => {
    const projectDir = tmpDir("cwd");
    tracker = new Tracker(path.join(tmpDir("db"), "runs.sqlite"));
    initState(new RunHost({ id: "test", command: "echo", label: "Test" } as AdapterDef, { projectDir, tracker }));
  });

  it("TOOL_HANDLERS registry covers every advertised tool (drift guard)", () => {
    const advertised = handleListTools().tools.map(t => t.name).sort();
    const implemented = Object.keys(TOOL_HANDLERS).sort();
    expect(implemented).toEqual(advertised);
  });

  it("throws MethodNotFound for an unknown tool", async () => {
    await expect(executeTool("does_not_exist", {}, FAKE_EXTRA))
      .rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it("guide tool returns the ORC guide text", async () => {
    const result = await executeTool("guide", { task: "hello" }, FAKE_EXTRA);
    expect((result.content[0] as TextContent).type).toBe("text");
    expect(textOf(result)).toContain("ORC");
    expect(textOf(result)).toContain("# User Task");
    expect(textOf(result)).toContain("hello");
  });

  it("return_result without a completionKey records without signal emission", async () => {
    const result = await executeTool("return_result", { summary: "done" }, FAKE_EXTRA);
    expect(textOf(result)).toBe("Result recorded.");
  });

  it("list_workflows returns registered workflows", async () => {
    const result = handleListWorkflowsTool();
    expect(Array.isArray(JSON.parse(textOf(result)))).toBe(true);
  });

  it("list_runs returns an array (empty or populated)", async () => {
    const result = handleListRunsTool();
    expect(Array.isArray(JSON.parse(textOf(result)))).toBe(true);
  });

  it("get_run_status rejects an unknown runId with InvalidParams", async () => {
    await expect(handleGetRunStatusTool({ runId: "bogus-run" }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it("standalone handlers are typed as CallToolResult", () => {
    const guide = handleGuideTool({});
    expect(guide.content[0]).toMatchObject({ type: "text" });
    const ret = handleReturnResult({ summary: "x" });
    expect(ret.content[0]).toMatchObject({ type: "text" });
  });
});

