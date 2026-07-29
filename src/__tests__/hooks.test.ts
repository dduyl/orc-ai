import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHookFile, readHookEvents, removeHookFile } from "../hooks/endpoint.js";
import { writeFileSync, existsSync } from "node:fs";

describe("createHookFile", () => {
  it("creates a writable file path", () => {
    const path = createHookFile("test-step");
    expect(path).toBeTruthy();
    expect(path.endsWith("events.jsonl")).toBe(true);
    removeHookFile(path);
  });
});

describe("readHookEvents", () => {
  it("returns empty array for missing file", () => {
    const events = readHookEvents("C:\\nonexistent\\path.jsonl");
    expect(events).toEqual([]);
  });

  it("returns empty array for empty file", () => {
    const path = createHookFile("empty-test");
    const events = readHookEvents(path);
    expect(events).toEqual([]);
    removeHookFile(path);
  });

  it("parses valid JSON lines into HookEvent objects", () => {
    const path = createHookFile("parse-test");
    const line1 = JSON.stringify({ type: "tool_call", timestamp: 1000, stepId: "s1", tool: "codegen", input: "write code" });
    const line2 = JSON.stringify({ type: "tool_result", timestamp: 1001, stepId: "s1", tool: "codegen", output: "done" });
    const line3 = JSON.stringify({ type: "step_finish", timestamp: 1002, stepId: "s1", reason: "stop" });
    writeFileSync(path, [line1, line2, line3].join("\n") + "\n", "utf-8");

    const events = readHookEvents(path);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("tool_call");
    expect((events[0] as any).tool).toBe("codegen");
    expect(events[1].type).toBe("tool_result");
    expect((events[1] as any).output).toBe("done");
    expect(events[2].type).toBe("step_finish");
    expect((events[2] as any).reason).toBe("stop");
    removeHookFile(path);
  });

  it("skips invalid lines", () => {
    const path = createHookFile("invalid-test");
    const valid = JSON.stringify({ type: "step_finish", timestamp: 1000, stepId: "s1", reason: "done" });
    writeFileSync(path, `not json\n${valid}\n{"type":"bad"}\n`, "utf-8");

    const events = readHookEvents(path);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("step_finish");
    removeHookFile(path);
  });
});

describe("removeHookFile", () => {
  it("removes the parent directory", () => {
    const path = createHookFile("cleanup-test");
    expect(existsSync(path)).toBe(true);
    removeHookFile(path);
    expect(existsSync(path)).toBe(false);
  });

  it("does not throw for already-deleted file", () => {
    removeHookFile("C:\\nonexistent\\path.jsonl");
  });
});
