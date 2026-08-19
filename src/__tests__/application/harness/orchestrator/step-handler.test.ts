import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StreamEmitter } from "../../../../adapters/stream/emitter.js";
import { parseRun } from "../../../../application/harness/execution/CommandExecutor.js";
import type { CommandExecutionResult } from "../../../../application/harness/execution/CommandExecutor.js";
import type { RunContext } from "../../../../application/harness/execution/step-runner.js";
import { createStepHandler, buildRepairPrompt } from "../../../../application/harness/orchestrator/step-handler.js";
import { Tracker } from "../../../../application/harness/persistence/Tracker.js";
import { AgentCallError } from "../../../../application/agents/errors.js";
import type { WorkflowStep } from "../../../../core/schemas.js";

const { agentCalls, mockState } = vi.hoisted(() => {
  const mockState: {
    killed: number;
    pending: boolean;
    killSettles: boolean;
    resolve?: (v?: unknown) => void;
    rejectWith?: unknown;
    callCount: number;
    downgradeParams: Array<string | undefined>;
    sequence?: Array<{ rejectWith?: unknown; resolveValue?: unknown }>;
  } = { killed: 0, pending: false, killSettles: true, callCount: 0, downgradeParams: [] };
  return { agentCalls: [] as string[], mockState };
});

vi.mock("../../../../application/agents/adapter-pty.js", () => ({
  callAgentStream: (_adapter: unknown, prompt: string, _hook?: string, downgradeTo?: string) => {
    agentCalls.push(prompt);
    mockState.callCount++;
    mockState.downgradeParams.push(downgradeTo);
    const entry = mockState.sequence?.[mockState.callCount - 1];
    const rejectWith = entry?.rejectWith !== undefined ? entry.rejectWith : mockState.rejectWith;
    const resolveValue = entry?.resolveValue;
    const pty = {
      onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {},
      kill: () => {
        mockState.killed++;
        // Like the real node-pty onExit path: killing settles the call. When
        // killSettles is false we emulate a win32 bash-wrapped spawn where kill
        // never fires onExit — only the completion rejection can settle the race.
        if (mockState.pending && mockState.killSettles) mockState.resolve?.({ content: "partial", model: "mock", tokensUsed: 0, duration: 0 });
      },
      pid: 1, cols: 120, rows: 40,
    };
    return {
      pty,
      promise: mockState.pending
        ? new Promise(resolve => { mockState.resolve = resolve; })
        : rejectWith !== undefined
          ? Promise.reject(rejectWith)
          : resolveValue !== undefined
            ? Promise.resolve({ ...resolveValue, ...(downgradeTo ? { downgradedTo: downgradeTo } : {}) })
            : Promise.resolve({ content: "mock", model: "mock", tokensUsed: 0, duration: 0, ...(downgradeTo ? { downgradedTo: downgradeTo } : {}) }),
    };
  },
}));

const sig = (name: string): { name: string; description: string } => ({ name, description: name });

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
  const base = { id, type: "script", context: [], emits: [sig("sig_pass"), sig("sig_fail")], on: ["__start__"] };
  return { ...base, ...(extra as any) } as WorkflowStep;
}

function ctx(): RunContext {
  return {
    workflowId: "wf1",
    stepResults: new Map(),
    buildResults: new Map(),
    maxRetries: 1,
    repairFeedbacks: new Map(),
  };
}

function makeHandler(
  execute: (run: string) => Promise<{ ok: false; error: string } | { ok: true; result: CommandExecutionResult }>,
) {
  return createStepHandler({
    adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
    agentPrompts: new Map(),
    completedSummaries: new Map(),
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
  it("runs an exec and maps exit 0 to emits[0] signal", async () => {
    const handler = makeHandler(async () => ({ ok: true, result: result(true, 0) }));
    const out = await handler(step("s1", { run: 'exec "exit 0"' }), ctx());
    expect(out.status).toBe("completed");
    expect(out.signal).toBe("sig_pass");
  });

  it("maps a failing exec to emits[1] signal", async () => {
    const handler = makeHandler(async () => ({ ok: true, result: result(false, 1, "out", "err") }));
    const out = await handler(step("s1", { run: 'exec "exit 1"' }), ctx());
    expect(out.status).toBe("completed");
    expect(out.signal).toBe("sig_fail");
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
    expect(out.signal).toBe("sig_pass");
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

describe("step-handler script summaries", () => {
  it("does not leak exit code or output into the StepSummary", async () => {
    const summaries = new Map<string, import("../../../../application/harness/orchestrator/types.js").StepSummary>();
    const c = ctx();
    const handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map(),
      completedSummaries: summaries,
        emitter: emitter(),
      task: "t",
      commandExecutor: {
        execute: async () => ({
          ok: true as const,
          result: { schemaVersion: 1, passed: false, exitCode: 7, groups: [{ name: "g", command: "boom", exitCode: 7, stdout: "o", stderr: "e" }] },
        }),
      } as any,
    });
    const out = await handler(step("s1", { run: 'exec "boom"' }), c);
    expect(out.signal).toBe("sig_fail");
    const s = summaries.get("s1")!;
    expect(s).toEqual({ summary: "Script gate failed (exit 7)", artifact: "", affectedFiles: [] });
    expect("exitCode" in s).toBe(false);
    expect("stdout" in s).toBe(false);
    expect("stderr" in s).toBe(false);
    expect(c.buildResults.get("s1")?.exitCode).toBe(7);
  });
});

describe("buildRepairPrompt", () => {
  const agentStep: WorkflowStep = { id: "code", type: "agent", agent: "codegen", emits: [sig("sig_done")], on: ["__start__"], context: [] };

  it("renders a single command block for exec", () => {
    const result: CommandExecutionResult = {
      schemaVersion: 1,
      passed: false,
      exitCode: 1,
      groups: [{ name: "inline", command: "npx tsc --noEmit", exitCode: 1, stdout: "", stderr: "tsc: line 42, undefined name 'x'" }],
    };
    const prompt = buildRepairPrompt("validate", result, agentStep, "key-123");
    expect(prompt).toContain("=== PREVIOUS VALIDATION FAILURE — FIX REQUIRED ===");
    expect(prompt).toContain("The 'validate' gate failed. Repair the issue, then re-run the validation.");
    expect(prompt).toContain("--- command 1/1 ---");
    expect(prompt).toContain("command: npx tsc --noEmit");
    expect(prompt).toContain("exit code: 1");
    expect(prompt).toContain("stderr:");
    expect(prompt).toContain("tsc: line 42, undefined name 'x'");
    expect(prompt).toContain('completionKey: "key-123"');
  });

  it("renders one block per command in a cmd group", () => {
    const result: CommandExecutionResult = {
      schemaVersion: 1,
      passed: false,
      exitCode: 2,
      groups: [
        { name: "test.unit", command: "npm run lint", exitCode: 0, stdout: "lint ok", stderr: "" },
        { name: "test.unit", command: "npx vitest run", exitCode: 2, stdout: "", stderr: "FAIL tests/a.test.ts" },
      ],
    };
    const prompt = buildRepairPrompt("test_unit", result, agentStep);
    expect(prompt).toContain("--- command 1/2 ---");
    expect(prompt).toContain("command: npm run lint");
    expect(prompt).toContain("--- command 2/2 ---");
    expect(prompt).toContain("command: npx vitest run");
    expect(prompt).toContain("FAIL tests/a.test.ts");
  });

  it("includes response instructions so the producer emits a summary", () => {
    const result: CommandExecutionResult = {
      schemaVersion: 1,
      passed: false,
      exitCode: 1,
      groups: [{ name: "inline", command: "false", exitCode: 1, stdout: "", stderr: "" }],
    };
    const prompt = buildRepairPrompt("validate", result, agentStep);
    expect(prompt).toContain("=== Response Instructions ===");
    expect(prompt).toContain("return_result");
  });

  it("compresses oversized gate output and annotates the ratio", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const result: CommandExecutionResult = {
      schemaVersion: 1,
      passed: false,
      exitCode: 1,
      groups: [{ name: "inline", command: "npx vitest run", exitCode: 1, stdout: big, stderr: "" }],
    };
    const prompt = buildRepairPrompt("test_unit", result, agentStep);
    expect(prompt).toContain("[output compressed:");
    expect(prompt).toContain("lines omitted]");
    expect(prompt).toContain("line 0");
    expect(prompt).toContain("line 499");
    expect(prompt).not.toContain("line 250");
  });

  it("annotates per-group compression when one command floods but the other is small", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const result: CommandExecutionResult = {
      schemaVersion: 1,
      passed: false,
      exitCode: 1,
      groups: [
        { name: "test.unit", command: "npm run lint", exitCode: 0, stdout: "lint ok", stderr: "" },
        { name: "test.unit", command: "npx vitest run", exitCode: 1, stdout: big, stderr: "" },
      ],
    };
    const prompt = buildRepairPrompt("test_unit", result, agentStep);
    const markerCount = prompt.split("[output compressed:").length - 1;
    expect(markerCount).toBe(1);
    expect(prompt).toContain("lint ok");
    expect(prompt).not.toContain("line 250");
  });

  it("leaves small gate output untouched (no compression marker)", () => {
    const result: CommandExecutionResult = {
      schemaVersion: 1,
      passed: false,
      exitCode: 1,
      groups: [{ name: "inline", command: "npx tsc --noEmit", exitCode: 1, stdout: "small out", stderr: "small err" }],
    };
    const prompt = buildRepairPrompt("validate", result, agentStep);
    expect(prompt).not.toContain("[output compressed:");
    expect(prompt).toContain("small out");
    expect(prompt).toContain("small err");
  });

  it("annotates blank-only oversized output and drops the stdout block", () => {
    const blank = "\n\n\n\n".repeat(300);
    const result: CommandExecutionResult = {
      schemaVersion: 1,
      passed: false,
      exitCode: 1,
      groups: [{ name: "inline", command: "npx vitest run", exitCode: 1, stdout: blank, stderr: "" }],
    };
    const prompt = buildRepairPrompt("test_unit", result, agentStep);
    expect(prompt).toContain("[output compressed:");
    expect(prompt).not.toContain("stdout:");
  });
});

describe("step-handler repair feedback", () => {
  const codeStep = (): WorkflowStep => ({
    id: "code", type: "agent", agent: "codegen", emits: [sig("sig_done")], any: ["__start__", "validate.sig_fail"], context: [],
  });
  const gateStep = (): WorkflowStep => ({
    id: "validate", type: "script", run: 'cmd "validate"', emits: [sig("sig_pass"), sig("sig_fail")], on: ["code.sig_done"], context: [],
  });

  it("replaces the main prompt with a repair prompt on producer re-run", async () => {
    agentCalls.length = 0;
    const summaries = new Map<string, import("../../../../application/harness/orchestrator/types.js").StepSummary>();
    const handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: summaries,
        emitter: emitter(),
      task: "build feature",
      commandExecutor: {
        execute: async () => ({
          ok: true as const,
          result: { schemaVersion: 1, passed: false, exitCode: 1, groups: [{ name: "validate", command: "npm run check", exitCode: 1, stdout: "", stderr: "check failed" }] },
        }),
      } as any,
    });

    const c = ctx();
    await handler(gateStep(), c);
    // The runner attaches the fail-signal feedback to the redo step's dispatch.
    c.pendingRepair = c.repairFeedbacks.get("validate.sig_fail");
    await handler(codeStep(), c);

    expect(agentCalls.length).toBe(1);
    const prompt = agentCalls[0];
    expect(prompt).toContain("SYS");
    expect(prompt).toContain("=== PREVIOUS VALIDATION FAILURE — FIX REQUIRED ===");
    expect(prompt).toContain("The 'validate' gate failed. Repair the issue, then re-run the validation.");
    expect(prompt).toContain("check failed");
    expect(prompt).not.toContain("=== Original Request ===");
  });

  it("clears the repair feedback once the gate passes", async () => {
    agentCalls.length = 0;
    const summaries = new Map<string, import("../../../../application/harness/orchestrator/types.js").StepSummary>();
    let gateFailed = true;
    const handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: summaries,
        emitter: emitter(),
      task: "t",
      commandExecutor: {
        execute: async () => {
          const passed = !gateFailed;
          return {
            ok: true as const,
            result: { schemaVersion: 1, passed, exitCode: passed ? 0 : 1, groups: [{ name: "validate", command: "c", exitCode: passed ? 0 : 1, stdout: "", stderr: passed ? "" : "e" }] },
          };
        },
      } as any,
    });

    const c = ctx();
    await handler(gateStep(), c);
    c.pendingRepair = c.repairFeedbacks.get("validate.sig_fail");
    await handler(codeStep(), c);
    expect(agentCalls[0]).toContain("PREVIOUS VALIDATION FAILURE");

    agentCalls.length = 0;
    gateFailed = false;
    await handler(gateStep(), c);
    c.pendingRepair = c.repairFeedbacks.get("validate.sig_fail");
    await handler(codeStep(), c);
    expect(agentCalls.length).toBe(1);
    expect(agentCalls[0]).not.toContain("PREVIOUS VALIDATION FAILURE");
    expect(agentCalls[0]).toContain("=== Original Request ===");
  });
});

describe("step-handler abort", () => {
  beforeEach(() => {
    agentCalls.length = 0;
    mockState.killed = 0;
    mockState.pending = false;
    mockState.killSettles = true;
    mockState.resolve = undefined;
    mockState.rejectWith = undefined;
  });

  it("kills the in-flight PTY and returns a cancelled outcome on abort", async () => {
    mockState.pending = true;
    const ctrl = new AbortController();
    const c = ctx();
    c.signal = ctrl.signal;
    const agentStep: WorkflowStep = {
      id: "code", type: "agent", agent: "codegen", emits: [sig("sig_done")], on: ["__start__"], context: [],
    };
    const handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: emitter(),
      task: "t",
    });

    const p = handler(agentStep, c);
    await new Promise(r => setTimeout(r, 0));
    expect(mockState.killed).toBe(0);
    ctrl.abort();
    const out = await p;

    expect(mockState.killed).toBe(1);
    expect(out.status).toBe("failed");
    expect(out.error).toBe("cancelled");
  });

  it("does not retry or run an agent step once the signal has aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const c = ctx();
    c.signal = ctrl.signal;
    const agentStep: WorkflowStep = {
      id: "code", type: "agent", agent: "codegen", emits: [sig("sig_done")], on: ["__start__"], context: [],
    };
    const handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: emitter(),
      task: "t",
    });
    const out = await handler(agentStep, c);
    expect(agentCalls.length).toBe(0);
    expect(out.status).toBe("failed");
    expect(out.error).toBe("cancelled");
  });

  it("settles via completion rejection even when killing never fires onExit", async () => {
    mockState.pending = true;
    mockState.killSettles = false;
    const ctrl = new AbortController();
    const c = ctx();
    c.signal = ctrl.signal;
    const agentStep: WorkflowStep = {
      id: "code", type: "agent", agent: "codegen", emits: [sig("sig_done")], on: ["__start__"], context: [],
    };
    const handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: emitter(),
      task: "t",
    });

    const p = handler(agentStep, c);
    await new Promise(r => setTimeout(r, 0));
    expect(mockState.killed).toBe(0);
    ctrl.abort();
    const out = await p;

    expect(mockState.killed).toBe(1);
    expect(out.status).toBe("failed");
    expect(out.error).toBe("cancelled");
  });

  it("quota: pauses the run immediately with QuotaExhausted and zero retries, quota payload preserved", async () => {
    mockState.rejectWith = new AgentCallError("quota", "You exceeded your current quota", {
      resetAtMs: 1755600000000,
    });
    const agentStep: WorkflowStep = {
      id: "code", type: "agent", agent: "codegen", emits: [sig("sig_done")], on: ["__start__"], context: [],
    };
    const handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: emitter(),
      task: "t",
    });

    const out = await handler(agentStep, ctx());

    expect(out.status).toBe("paused");
    expect(out.error).toBe("You exceeded your current quota");
    expect(out.failureReason).toBe("quota_exhausted");
    expect(out.quota).toEqual({ kind: "quota", resetAtMs: 1755600000000, message: "You exceeded your current quota" });
    // Phase 1: quota is a no-retry kind — the exact resetAtMs that entered the
    // classifier reaches the outcome un-cut, and callAgentStream runs once.
    expect(agentCalls.length).toBe(1);
  });
});

describe("step-handler ADR-022 retry policy", () => {
  const agentStep = (): WorkflowStep => ({
    id: "code", type: "agent", agent: "codegen", emits: [sig("sig_done")], on: ["__start__"], context: [],
  });
  const makeHandler = () =>
    createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: emitter(),
      task: "t",
    });

  beforeEach(() => {
    agentCalls.length = 0;
    mockState.pending = false;
    mockState.killSettles = true;
    mockState.resolve = undefined;
    mockState.rejectWith = undefined;
  });

  /** Record the requested sleep durations while firing them near-instantly so the handler completes for real. */
  function withRecordedSleep(run: (delays: number[]) => Promise<void>): Promise<void> {
    const delays: number[] = [];
    const orig = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: (...args: unknown[]) => void, ms: number, ...rest: unknown[]) => {
      delays.push(ms);
      return orig(fn, Math.min(ms, 5), ...rest);
    };
    return run(delays).finally(() => {
      (globalThis as any).setTimeout = orig;
    });
  }

  it("quota: no retry, no backoff sleep, run pauses with QuotaExhausted payload", async () => {
    mockState.rejectWith = new AgentCallError("quota", "quota exceeded", { resetAtMs: 1755600000000 });
    await withRecordedSleep(async delays => {
      const out = await makeHandler()(agentStep(), ctx());
      expect(delays).toEqual([]);
      expect(out.status).toBe("paused");
      expect(out.failureReason).toBe("quota_exhausted");
      expect(out.quota?.resetAtMs).toBe(1755600000000);
      expect(agentCalls.length).toBe(1);
    });
  });

  it("rate_limit: bounded backoff base*2^attempt between retries, then fail", async () => {
    mockState.rejectWith = new AgentCallError("rate_limit", "429 too many requests");
    const c = ctx();
    c.maxRetries = 3;
    await withRecordedSleep(async delays => {
      const out = await makeHandler()(agentStep(), c);
      expect(delays).toEqual([1000, 2000, 4000]);
      expect(out.status).toBe("failed");
      expect(out.failureReason).toBeUndefined();
      expect(agentCalls.length).toBe(4);
    });
  });

  it("rate_limit: Retry-After overrides the exponential sequence", async () => {
    mockState.rejectWith = new AgentCallError("rate_limit", "retry after", { retryAfterMs: 2500 });
    await withRecordedSleep(async delays => {
      const out = await makeHandler()(agentStep(), ctx());
      expect(delays).toEqual([2500]);
      expect(out.status).toBe("failed");
      expect(agentCalls.length).toBe(2);
    });
  });

  it("auth: fails fast with no retry and no sleep", async () => {
    mockState.rejectWith = new AgentCallError("auth", "invalid api key");
    await withRecordedSleep(async delays => {
      const out = await makeHandler()(agentStep(), ctx());
      expect(delays).toEqual([]);
      expect(out.status).toBe("failed");
      expect(agentCalls.length).toBe(1);
    });
  });

  it.each(["connection", "spawn"] as const)("%s: bounded backoff then fail", async kind => {
    mockState.rejectWith = new AgentCallError(kind, `${kind} failed`);
    await withRecordedSleep(async delays => {
      const out = await makeHandler()(agentStep(), ctx());
      expect(delays).toEqual([1000]);
      expect(out.status).toBe("failed");
      expect(agentCalls.length).toBe(2);
    });
  });

  it("unknown: one bounded backoff then fail (escape hatch)", async () => {
    mockState.rejectWith = new Error("something unexpected");
    await withRecordedSleep(async delays => {
      const out = await makeHandler()(agentStep(), ctx());
      expect(delays).toEqual([1000]);
      expect(out.status).toBe("failed");
      expect(out.error).toBe("something unexpected");
      expect(agentCalls.length).toBe(2);
    });
  });
});

describe("step-handler quota surfacing chain", () => {
  const agentStep = (): WorkflowStep => ({
    id: "code", type: "agent", agent: "codegen", emits: [sig("sig_done")], on: ["__start__"], context: [],
  });

  function buildHarness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-quota-chain-"));
    const tracker = new Tracker(path.join(dir, "runs.sqlite"));
    const runId = "run-chain-1";
    tracker.createRun(runId, "wf", "WF", "t", "test", [{ stepId: "code", agent: "codegen", task: null, signals: [] }]);
    const em = new StreamEmitter("ses-chain");
    const streamEvents: any[] = [];
    em.on("event", e => streamEvents.push(e));
    const progress: any[] = [];
    const handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: em,
      task: "t",
      tracker: { runId, tracker },
      onProgress: e => progress.push(e),
    });
    return {
      dir,
      tracker,
      runId,
      emitter: em,
      streamEvents,
      progress,
      handler,
      cleanup: () => {
        tracker.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  beforeEach(() => {
    agentCalls.length = 0;
    mockState.callCount = 0;
    mockState.downgradeParams = [];
    mockState.sequence = undefined;
    mockState.rejectWith = undefined;
  });

  it("quota: structured payload is value-equal across outcome, progress, tracker, and stream", async () => {
    mockState.rejectWith = new AgentCallError("quota", "You exceeded your current quota", {
      resetAtMs: 1755600000000,
    });
    const h = buildHarness();
    try {
      const out = await h.handler(agentStep(), ctx());
      const expected = { kind: "quota", resetAtMs: 1755600000000, message: "You exceeded your current quota" };

      expect(out.status).toBe("paused");
      expect(out.failureReason).toBe("quota_exhausted");
      expect(out.quota).toEqual(expected);

      const complete = h.progress.find((e: any) => e.type === "step_complete");
      expect(complete.status).toBe("paused");
      expect(complete.error).toBe("You exceeded your current quota");
      expect(complete.quota).toEqual(expected);

      const step = h.tracker.getRun(h.runId)!.steps[0];
      expect(step.status).toBe("failed");
      expect(step.error).toBe("[quota] You exceeded your current quota");
      expect(step.quota).toEqual(expected);

      const finish = h.streamEvents.find((e: any) => e.type === "step_finish");
      expect(finish.part.reason).toBe("quota");
      expect(finish.part.quota).toEqual(expected);
    } finally {
      h.cleanup();
    }
  });

  it("non-quota completion: quota stays absent across progress, tracker, and stream", async () => {
    mockState.rejectWith = undefined;
    const h = buildHarness();
    try {
      const out = await h.handler(agentStep(), ctx());
      expect(out.status).toBe("completed");

      const complete = h.progress.find((e: any) => e.type === "step_complete");
      expect(complete.quota).toBeUndefined();

      const step = h.tracker.getRun(h.runId)!.steps[0];
      expect(step.quota).toBeNull();

      const finish = h.streamEvents.find((e: any) => e.type === "step_finish");
      expect(finish.part.quota).toBeUndefined();
      expect(finish.part.reason).toBe("stop");
    } finally {
      h.cleanup();
    }
  });

  it("quota → downgrade → second quota: pauses with downgradedTo value-equal across outcome, progress, tracker, stream", async () => {
    mockState.sequence = [
      { rejectWith: new AgentCallError("quota", "first quota", { resetAtMs: 111 }) },
      { rejectWith: new AgentCallError("quota", "second quota", { resetAtMs: 222 }) },
    ];
    const h = buildHarness();
    h.handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: h.emitter,
      task: "t",
      tracker: { runId: h.runId, tracker: h.tracker },
      onProgress: e => h.progress.push(e),
      resolveDowngradeModel: () => "claude-haiku",
    });
    try {
      const out = await h.handler(agentStep(), ctx());
      const expected = { kind: "quota", resetAtMs: 222, message: "second quota", downgradedTo: "claude-haiku" };

      expect(out.status).toBe("paused");
      expect(out.failureReason).toBe("quota_exhausted");
      expect(out.downgradedTo).toBe("claude-haiku");
      expect(out.quota).toEqual(expected);
      // exactly two adapter calls: the original attempt + one downgraded retry.
      expect(agentCalls.length).toBe(2);
      expect(mockState.downgradeParams).toEqual([undefined, "claude-haiku"]);

      const complete = h.progress.find((e: any) => e.type === "step_complete");
      expect(complete.status).toBe("paused");
      expect(complete.error).toBe("second quota");
      expect(complete.quota).toEqual(expected);

      const step = h.tracker.getRun(h.runId)!.steps[0];
      expect(step.status).toBe("failed");
      expect(step.quota).toEqual(expected);

      const finish = h.streamEvents.find((e: any) => e.type === "step_finish");
      expect(finish.part.reason).toBe("quota");
      expect(finish.part.quota).toEqual(expected);
    } finally {
      h.cleanup();
    }
  });

  it("quota → downgrade → success: step completes and surfaces downgradedTo with two adapter calls", async () => {
    mockState.sequence = [
      { rejectWith: new AgentCallError("quota", "first quota", { resetAtMs: 111 }) },
      { resolveValue: { content: "done", model: "test", tokensUsed: 5, duration: 1 } },
    ];
    const h = buildHarness();
    h.handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: h.emitter,
      task: "t",
      tracker: { runId: h.runId, tracker: h.tracker },
      onProgress: e => h.progress.push(e),
      resolveDowngradeModel: () => "claude-haiku",
    });
    try {
      const out = await h.handler(agentStep(), ctx());

      expect(out.status).toBe("completed");
      expect(out.downgradedTo).toBe("claude-haiku");
      expect(out.quota).toBeUndefined();
      expect(agentCalls.length).toBe(2);
      expect(mockState.downgradeParams).toEqual([undefined, "claude-haiku"]);

      const complete = h.progress.find((e: any) => e.type === "step_complete");
      expect(complete.status).toBe("completed");
      expect(complete.quota).toBeUndefined();

      const step = h.tracker.getRun(h.runId)!.steps[0];
      expect(step.status).toBe("completed");
      expect(step.quota).toBeNull();

      const finish = h.streamEvents.find((e: any) => e.type === "step_finish");
      expect(finish.part.reason).toBe("stop");
      expect(finish.part.quota).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it.each([
    ["same model as tried", (): string => "test"],
    ["empty string", (): string => ""],
    ["whitespace", (): string => "   "],
    ["throws", (): string => { throw new Error("boom"); }],
  ] as const)("quota with unusable resolveDowngradeModel (%s): pauses with no downgrade and a single adapter call", async (_label, callback) => {
    mockState.rejectWith = new AgentCallError("quota", "quota exceeded", { resetAtMs: 333 });
    mockState.sequence = undefined;
    const h = buildHarness();
    h.handler = createStepHandler({
      adapter: { id: "test", name: "test", provider: "openai", model: "x", url: "" } as any,
      agentPrompts: new Map([["codegen", { systemPrompt: "SYS", description: "d", outputs: [] }]]),
      completedSummaries: new Map(),
      emitter: h.emitter,
      task: "t",
      tracker: { runId: h.runId, tracker: h.tracker },
      onProgress: e => h.progress.push(e),
      resolveDowngradeModel: callback,
    });
    try {
      const out = await h.handler(agentStep(), ctx());

      expect(out.status).toBe("paused");
      expect(out.failureReason).toBe("quota_exhausted");
      expect(out.quota).toEqual({ kind: "quota", resetAtMs: 333, message: "quota exceeded" });
      expect(out.downgradedTo).toBeUndefined();
      expect(agentCalls.length).toBe(1);
      expect(mockState.downgradeParams).toEqual([undefined]);
    } finally {
      h.cleanup();
    }
  });
});
