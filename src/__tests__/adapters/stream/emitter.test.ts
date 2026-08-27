import { describe, it, expect } from "vitest";
import { StreamEmitter } from "../../../adapters/stream/emitter.js";
import type { StepFinishEvent } from "../../../adapters/stream/types.js";

describe("StreamEmitter", () => {
  it("stepFinish emits correct token structure from usage data", () => {
    const emitter = new StreamEmitter("test-sess-1");
    const events: StepFinishEvent[] = [];

    emitter.on("event", (event) => {
      if (event.type === "step_finish") {
        events.push(event as StepFinishEvent);
      }
    });

    emitter.stepStart("s1");
    emitter.stepFinish(
      "s1",
      "stop",
      "",
      { total: 150, input: 80, output: 70, reasoning: 5, cache: { write: 3, read: 2 } },
      0.001,
    );

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.type).toBe("step_finish");
    expect(event.part.tokens).toEqual({
      total: 150,
      input: 80,
      output: 70,
      reasoning: 5,
      cache: { write: 3, read: 2 },
    });
    expect(event.part.cost).toBe(0.001);
  });

  it("stepFinish uses fallback zeros when no usage", () => {
    const emitter = new StreamEmitter("test-sess-2");
    const events: StepFinishEvent[] = [];

    emitter.on("event", (event) => {
      if (event.type === "step_finish") {
        events.push(event as StepFinishEvent);
      }
    });

    emitter.stepStart("s2");
    emitter.stepFinish(
      "s2",
      "stop",
      "",
      { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
      0,
    );

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.part.tokens).toEqual({
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { write: 0, read: 0 },
    });
    expect(event.part.cost).toBe(0);
  });

  it("stepFinish emits quota info when provided", () => {
    const emitter = new StreamEmitter("test-sess-3");
    const events: StepFinishEvent[] = [];

    emitter.on("event", (event) => {
      if (event.type === "step_finish") {
        events.push(event as StepFinishEvent);
      }
    });

    emitter.stepStart("s3");
    emitter.stepFinish(
      "s3",
      "quota",
      "",
      { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
      0,
      { kind: "quota", resetAtMs: 12345, message: "over limit" },
    );

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.part.quota).toEqual({
      kind: "quota",
      resetAtMs: 12345,
      message: "over limit",
    });
  });
});
