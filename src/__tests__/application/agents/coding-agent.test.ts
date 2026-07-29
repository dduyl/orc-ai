import { describe, it, expect } from "vitest";
import { callAgentStream } from "../../../application/agents/adapter-pty.js";
import { registerStrategy, type AgentStrategy } from "../../../application/agents/strategy.js";
import type { AdapterDef } from "../../../application/agents/adapter.js";

describe("coding-agent", () => {
  it("spawns coding agent PTY", () => {
    const strat: AgentStrategy = {
      id: "opencode-test",
      buildArgs: () => [],
      keepAlive: false,
      isComplete: () => true,
      extractOutput: (s) => s,
    };
    registerStrategy(strat);

    const command = process.platform === "win32" ? "cmd.exe" : "echo";
    const adapter: AdapterDef = {
      id: "opencode-test",
      command,
      label: "Test Coding Agent",
    };

    const handle = callAgentStream(adapter, "write code");
    expect(handle.pty).toBeDefined();
    handle.promise.catch(() => {}); // handle rejected promise gracefully in test
  });
});
