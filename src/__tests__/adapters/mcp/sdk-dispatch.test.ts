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
  handleRunWorkflow,
} from "../../../adapters/mcp/handlers/workflow-handlers.js";
import { handleGuideTool, handleReturnResult } from "../../../adapters/mcp/handlers/result-handlers.js";
import { handleListTools } from "../../../adapters/mcp/handlers/capabilities.js";
import { init as initState } from "../../../adapters/mcp/handlers/state.js";
import { RunHost } from "../../../application/harness/run-host.js";
import type { AdapterDef } from "../../../application/agents/adapter.js";
import type { RunHandlerExtra } from "../../../adapters/mcp/handlers/workflow-handlers.js";
import { Tracker } from "../../../application/harness/persistence/Tracker.js";
import { WorkflowRegistry } from "../../../application/planner/registry.js";
import * as fs from "node:fs";

const FAKE_EXTRA: RunHandlerExtra = {
  sendNotification: async () => {},
  signal: new AbortController().signal,
};

function tmpDir(label: string): string {
  return path.join(os.tmpdir(), `orc-sdk-dispatch-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/** Cross-platform command that blocks long enough for concurrency to be observable. */
const BLOCK_CMD = process.platform === "win32" ? "ping -n 4 127.0.0.1 >nul" : "sleep 3";

/** Single script gate workflow; `runExpr` is the script step's `run` value. */
function scriptWorkflow(id: string, runExpr: string): object {
  return {
    version: 1,
    workflow: {
      id,
      name: id,
      description: "sdk concurrency test workflow",
      steps: [
        {
          id: "gate",
          type: "script",
          run: runExpr,
          emits: [
            { name: "pass", description: "ok" },
            { name: "fail", description: "bad" },
          ],
          on: ["__start__"],
        },
      ],
      completion: "done",
    },
  };
}

describe("MCP SDK dispatch", () => {
  let tracker: Tracker;
  let host: RunHost;

  beforeEach(() => {
    const projectDir = tmpDir("cwd");
    const workflowsDir = tmpDir("wf");
    tracker = new Tracker(path.join(tmpDir("db"), "runs.sqlite"));
    const registry = new WorkflowRegistry({ userDir: workflowsDir, builtinDir: tmpDir("builtin") });
    // Register a quick + a blocking script workflow so run_workflow has
    // something to load and run.
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, "smoke.json"), JSON.stringify(scriptWorkflow("smoke", 'exec "echo smoke"')));
    fs.writeFileSync(path.join(workflowsDir, "block.json"), JSON.stringify(scriptWorkflow("block", `exec "${BLOCK_CMD}"`)));
    registry.loadAll();
    host = new RunHost({ id: "test", command: "echo", label: "Test" } as AdapterDef, { projectDir, tracker, registry });
    initState(host);
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

describe("MCP SDK concurrent run_workflow (E0)", () => {
  let tracker: Tracker;
  let host: RunHost;

  beforeEach(() => {
    const projectDir = tmpDir("cwd");
    const workflowsDir = tmpDir("wf");
    tracker = new Tracker(path.join(tmpDir("db"), "runs.sqlite"));
    const registry = new WorkflowRegistry({ userDir: workflowsDir, builtinDir: tmpDir("builtin") });
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, "smoke.json"), JSON.stringify(scriptWorkflow("smoke", 'exec "echo smoke"')));
    fs.writeFileSync(path.join(workflowsDir, "block.json"), JSON.stringify(scriptWorkflow("block", `exec "${BLOCK_CMD}"`)));
    registry.loadAll();
    host = new RunHost({ id: "test", command: "echo", label: "Test" } as AdapterDef, { projectDir, tracker, registry });
    initState(host);
  });

  /** Returns the runId embedded in a run_workflow tool result. */
  function runIdOf(result: { content: any[] }): string {
    return (JSON.parse(textOf(result)) as { runId: string }).runId;
  }

  async function waitCompleted(runId: string, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const run = host.tracker.getRun(runId);
      if (run?.status === "completed") return;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for 'completed', got '${run?.status}'`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("two concurrent run_workflow calls with different tasks both complete via bgRuns", async () => {
    const [a, b] = await Promise.all([
      handleRunWorkflow({ task: "task-a", workflowId: "smoke" }, FAKE_EXTRA),
      handleRunWorkflow({ task: "task-b", workflowId: "smoke" }, FAKE_EXTRA),
    ]);
    const ra = runIdOf(a);
    const rb = runIdOf(b);
    expect(ra).not.toBe(rb);

    await Promise.all([host.bgRuns.get(ra), host.bgRuns.get(rb)]);
    expect(host.tracker.getRun(ra)?.status).toBe("completed");
    expect(host.tracker.getRun(rb)?.status).toBe("completed");
  });

  it("two concurrent run_workflow calls for the SAME task (non-resume) both complete — checkpoint overlap documented", async () => {
    // Both runs share the same task → same checkpoints.sqlite row. E0 run_id
    // ownership means a run only prunes its own row; neither run disturbs the
    // other's live state. Both must complete cleanly.
    const [a, b] = await Promise.all([
      handleRunWorkflow({ task: "same-task", workflowId: "block" }, FAKE_EXTRA),
      handleRunWorkflow({ task: "same-task", workflowId: "block" }, FAKE_EXTRA),
    ]);
    const ra = runIdOf(a);
    const rb = runIdOf(b);
    expect(ra).not.toBe(rb);

    await Promise.all([host.bgRuns.get(ra), host.bgRuns.get(rb)]);
    expect(host.tracker.getRun(ra)?.status).toBe("completed");
    expect(host.tracker.getRun(rb)?.status).toBe("completed");
  });

  it("a failing start (unknown workflowId) does not disturb an in-flight run", async () => {
    const started = await handleRunWorkflow({ task: "in-flight", workflowId: "block" }, FAKE_EXTRA);
    const runId = runIdOf(started);
    const pending = host.bgRuns.get(runId)!;

    // Give the run a moment to actually be in flight.
    const start = Date.now();
    while (host.tracker.getRun(runId)?.status !== "running") {
      if (Date.now() - start > 5000) throw new Error("run never reached running");
      await new Promise((r) => setTimeout(r, 10));
    }

    await expect(handleRunWorkflow({ task: "bad", workflowId: "__missing__" }, FAKE_EXTRA))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });

    // The in-flight run is untouched and still completes.
    expect(host.tracker.getRun(runId)?.status).toBe("running");
    await pending;
    await waitCompleted(runId);
  });
});

