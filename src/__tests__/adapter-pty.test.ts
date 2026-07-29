import { describe, it, expect, beforeAll } from "vitest";
import { callAgent } from "../agents/adapter-pty.js";
import { registerStrategy } from "../agents/strategy.js";
import type { AgentStrategy } from "../agents/strategy.js";
import type { AdapterDef } from "../agents/adapter.js";
import type { HookEvent } from "../hooks/types.js";

const echoStrategy: AgentStrategy = {
  id: "echo",
  buildArgs: (prompt: string) => {
    if (process.platform === "win32") return ["/c", "echo", "hello-pty"];
    return ["-c", "echo hello-pty"];
  },
  keepAlive: false,
  isComplete: () => false,
  extractOutput: (s: string) => s,
};

const multiStrategy: AgentStrategy = {
  id: "multi",
  buildArgs: (prompt: string) => {
    if (process.platform === "win32") return ["/c", "echo first & echo second & echo third"];
    return ["-c", "echo first; echo second; echo third"];
  },
  keepAlive: false,
  isComplete: () => false,
  extractOutput: (s: string) => s,
};

const cmd = process.platform === "win32" ? "cmd" : "sh";

const echoAdapter: AdapterDef = { id: "echo", command: cmd, label: "Echo" };
const multiAdapter: AdapterDef = { id: "multi", command: cmd, label: "Multi" };

describe("callAgent", () => {
  beforeAll(() => {
    registerStrategy(echoStrategy);
    registerStrategy(multiStrategy);
  });

  it("captures stdout from PTY subprocess", { timeout: 15000 }, async () => {
    const result = await callAgent(echoAdapter, "test prompt");
    expect(result.content).toBeTruthy();
    expect(result.content.toLowerCase()).toContain("hello-pty");
    expect(result.model).toBe("echo");
    expect(typeof result.duration).toBe("number");
    expect(result.duration).toBeGreaterThan(0);
  });

  it("captures multi-line output", { timeout: 15000 }, async () => {
    const result = await callAgent(multiAdapter, "hello");
    const lines = result.content.split("\n").filter(l => l.trim());
    const found = lines.filter(l => /first|second|third/i.test(l));
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  it("returns duration under 30s", { timeout: 15000 }, async () => {
    const result = await callAgent(echoAdapter, "test");
    expect(result.duration).toBeGreaterThan(0);
    expect(result.duration).toBeLessThan(30000);
  });
});
