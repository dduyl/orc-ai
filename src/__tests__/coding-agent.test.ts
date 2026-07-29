import { describe, it, expect, beforeAll } from "vitest";
import { callAgent } from "../agents/adapter-pty.js";
import { registerStrategy } from "../agents/strategy.js";
import type { AdapterDef } from "../agents/adapter.js";

beforeAll(() => {
  registerStrategy({
    id: "echo",
    buildArgs: () => ["/c", "echo", "hello from subprocess"],
    keepAlive: false,
    isComplete: () => false,
    extractOutput: (s: string) => s.trim(),
  });
});

describe("callAgent", () => {
  it("spawns command and returns stdout", { timeout: 15000 }, async () => {
    const def: AdapterDef = { id: "echo", command: "cmd", label: "Echo" };
    const result = await callAgent(def, "user context");
    expect(result.content).toContain("hello from subprocess");
    expect(typeof result.duration).toBe("number");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("reports the adapter id as model", { timeout: 15000 }, async () => {
    const def: AdapterDef = { id: "echo", command: "cmd", label: "Echo" };
    const result = await callAgent(def, "test");
    expect(result.model).toBe("echo");
    expect(result.content.length).toBeGreaterThan(0);
  });
});
