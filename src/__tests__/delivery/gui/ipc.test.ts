import { describe, expect, it, expectTypeOf } from "vitest";
import { IPC } from "../../../delivery/gui/ipc.js";
import type { StepFrame, MainToRendererEvents } from "../../../delivery/gui/ipc.js";

describe("IPC contract (gui)", () => {
  it("channel names are unique across all three groups", () => {
    const names = [
      ...Object.values(IPC.RendererToMain),
      ...Object.values(IPC.RendererToMainInvoke),
      ...Object.values(IPC.MainToRenderer),
    ];
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it("exposes the full main → renderer event surface", () => {
    // The `IPC` const is `satisfies`-checked against the typed channel maps at
    // compile time; this guards the runtime strings against accidental renames.
    expect(IPC.MainToRenderer.output).toBe("output");
    expect(IPC.MainToRenderer.status).toBe("status");
    expect(IPC.MainToRenderer["chat-frame"]).toBe("chat-frame");
    expect(IPC.MainToRenderer["chat-reset"]).toBe("chat-reset");
    expect(IPC.MainToRenderer["stream-event"]).toBe("stream-event");
  });

  describe("step-frame channel", () => {
    it("is registered in the MainToRenderer channel map", () => {
      expect(IPC.MainToRenderer["step-frame"]).toBe("step-frame");
    });

    it("channel key is present in the type-level map", () => {
      expectTypeOf(IPC.MainToRenderer).toHaveProperty("step-frame");
    });

    it("payload type is StepFrame", () => {
      // Compile-time: the channel's payload type must be assignable to StepFrame.
      expectTypeOf<MainToRendererEvents["step-frame"]>().toMatchTypeOf<StepFrame>();
      // And StepFrame must be assignable back — ensures 1:1 match.
      expectTypeOf<StepFrame>().toMatchTypeOf<MainToRendererEvents["step-frame"]>();
    });

    it("StepFrame has all required fields", () => {
      // Runtime shape check on a minimal valid StepFrame.
      const frame: StepFrame = {
        stepId: "step-1",
        runId: "run-1",
        status: "completed",
      };
      expect(frame.stepId).toBe("step-1");
      expect(frame.runId).toBe("run-1");
      expect(frame.status).toBe("completed");
    });

    it("StepFrame accepts every optional field", () => {
      const frame: StepFrame = {
        stepId: "step-2",
        runId: "run-2",
        status: "failed",
        error: "tool execution failed",
        errorKind: "tool_error",
        retryAfterMs: 5000,
        resetAtMs: 1700000000000,
        providerCode: "rate_limit",
        usage: { totalTokens: 150, inputTokens: 100, outputTokens: 50 },
        model: "gpt-4o",
        duration: 1234,
        toolCalls: [
          { toolCallId: "tc-1", name: "bash", rawInput: { cmd: "ls" } } as any,
        ],
      };

      expect(frame.error).toBe("tool execution failed");
      expect(frame.errorKind).toBe("tool_error");
      expect(frame.retryAfterMs).toBe(5000);
      expect(frame.resetAtMs).toBe(1700000000000);
      expect(frame.providerCode).toBe("rate_limit");
      expect(frame.usage).toEqual({ totalTokens: 150, inputTokens: 100, outputTokens: 50 });
      expect(frame.model).toBe("gpt-4o");
      expect(frame.duration).toBe(1234);
      expect(frame.toolCalls).toHaveLength(1);
      expect(frame.toolCalls![0].name).toBe("bash");
    });

    it("StepFrame optional fields are truly optional (omitted payload compiles and is valid)", () => {
      const frame: StepFrame = { stepId: "s", runId: "r", status: "running" };
      expect(frame.error).toBeUndefined();
      expect(frame.errorKind).toBeUndefined();
      expect(frame.retryAfterMs).toBeUndefined();
      expect(frame.resetAtMs).toBeUndefined();
      expect(frame.providerCode).toBeUndefined();
      expect(frame.usage).toBeUndefined();
      expect(frame.model).toBeUndefined();
      expect(frame.duration).toBeUndefined();
      expect(frame.toolCalls).toBeUndefined();
    });
  });
});