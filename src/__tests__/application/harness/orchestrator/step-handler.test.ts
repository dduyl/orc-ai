import { describe, it, expect } from "vitest";
import { StreamEmitter } from "../../../../adapters/stream/emitter.js";
import { parseRun } from "../../../../application/harness/execution/CommandExecutor.js";
import type { CommandExecutionResult } from "../../../../application/harness/execution/CommandExecutor.js";
import type { RunContext } from "../../../../application/harness/execution/step-runner.js";
import { createStepHandler } from "../../../../application/harness/orchestrator/step-handler.js";
import type { WorkflowStep } from "../../../../core/schemas.js";

function result(passed: boolean, exitCode: number, stdout = "", stderr = ""): CommandExecutionResult {
  return {
    schemaVersion: 1,
    passed,
    exitCode,
    groups: [{ name: "g", command: "some cmd", exitCode, stdout, stderr }],
  };
}

function emitter(): StreamEmitter {
  return new StreamEmitter();
}

function step(id: string, extra: Record<string, unknown> = {}): WorkflowStep {
  return { id, type: "script", depends_on: [], context: [], ...(extra as any) } as WorkflowStep;
}

function ctx(): RunContext {
  return {
    workflowId: "wf1",
    stepResults: new Map(),
    buildResults: new Map(),
    maxRetries: 1,
  };
}

function makeHandler(
  execute: (run: string) => Promise<{ ok: false; error: string } | { ok: true; result: CommandExecutionResult }>,
) {
  return createStepHandler({
    adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
    agentPrompts: new Map(),
    completedSummaries: new Map(),
    allOutcomes: [],
    emitter: emitter(),
    task: "t",
    commandExecutor: { execute } as any,
  });
}

describe("parseRun", () => {
  it("parses exec to an inline command", () => {
    expect(parseRun('exec "exit 0"')).toEqual({ ok: true, intent: { kind: "exec", command: "exit 0" } });
  });

  it("parses cmd to a group key", () => {
    expect(parseRun('cmd "test.unit"')).toEqual({ ok: true, intent: { kind: "cmd", key: "test.unit" } });
  });

  it("parses commands containing escaped quotes", () => {
    expect(parseRun('exec "echo \\"hi\\""')).toEqual({ ok: true, intent: { kind: "exec", command: 'echo "hi"' } });
  });

  it.each([
    ["a bare path", "scripts/check.js"],
    ["unquoted arg", 'cmd test.unit'],
    ["empty exec", 'exec ""'],
    ["empty cmd", 'cmd ""'],
    ["stray text", "test.unit"],
    ["stray text after quote", 'exec "node -v" extra'],
    ["empty string", ""],
    ["mismatched parens led", 'exec("exit 0")'],
  ])("rejects %s", (_label, input) => {
    expect(parseRun(input).ok).toBe(false);
  });
});

describe("step-handler script steps", () => {
  it("runs an exec and maps exit 0 to completed + signal true", async () => {
    const handler = makeHandler(async () => ({ ok: true, result: result(true, 0) }));
    const out = await handler(step("s1", { run: 'exec "exit 0"' }), ctx());
    expect(out.status).toBe("completed");
    expect(out.signal).toBe(true);
  });

  it("maps a failing exec to completed + signal false", async () => {
    const handler = makeHandler(async () => ({ ok: true, result: result(false, 1, "out", "err") }));
    const out = await handler(step("s1", { run: 'exec "exit 1"' }), ctx());
    expect(out.status).toBe("completed");
    expect(out.signal).toBe(false);
  });

  it("dispatches an exec to the executor", async () => {
    const calls: string[] = [];
    const handler = makeHandler(async (run) => {
      calls.push(run);
      return { ok: true, result: result(true, 0) };
    });
    const out = await handler(step("s1", { run: 'exec "node --check src/index.js"' }), ctx());
    expect(calls).toEqual(['exec "node --check src/index.js"']);
    expect(out.status).toBe("completed");
    expect(out.signal).toBe(true);
  });

  it("records the exit code and annotated output in buildResults", async () => {
    const c = ctx();
    const handler = makeHandler(async () => ({
      ok: true as const,
      result: {
        schemaVersion: 1,
        passed: false,
        exitCode: 9,
        groups: [
          { name: "g", command: "echo pass", exitCode: 0, stdout: "line1", stderr: "" },
          { name: "g", command: "node fail.js", exitCode: 9, stdout: "", stderr: "boom" },
        ],
      },
    }));
    await handler(step("s1", { run: 'cmd "test.unit"' }), c);
    const b = c.buildResults.get("s1");
    expect(b?.exitCode).toBe(9);
    expect(b?.stdout).toBe("$ echo pass\nline1");
    expect(b?.stderr).toBe("$ node fail.js\nboom");
  });

  it("hard-fails on a malformed run expression", async () => {
    const spy = makeHandler(async () => ({ ok: false, error: "malformed" }));
    const out = await spy(step("s1", { run: "test.unit" }), ctx());
    expect(out.status).toBe("failed");
  });

  it("hard-fails a script step with no run expression", async () => {
    const neverCalled = makeHandler(async () => { throw new Error("should not run"); });
    const out = await neverCalled(step("s1"), ctx());
    expect(out.status).toBe("failed");
  });
});