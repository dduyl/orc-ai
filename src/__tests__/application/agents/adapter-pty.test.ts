import { describe, it, expect, vi } from "vitest";
import { callAgentStream } from "../../../application/agents/adapter-pty.js";
import { getStrategy, registerStrategy, type AgentStrategy } from "../../../application/agents/strategy.js";
import type { AdapterDef } from "../../../application/agents/adapter.js";
import type { HookEvent } from "../../../core/hooks.js";

describe("adapter-pty", () => {
  it("calls agent stream with strategy", () => {
    const mockStrategy: AgentStrategy = {
      id: "mock-agent",
      buildArgs: () => ["--mock"],
      keepAlive: false,
      isComplete: (events: HookEvent[]) => events.some(e => e.type === "step_finish"),
      extractOutput: (out: string) => out.trim(),
    };

    registerStrategy(mockStrategy);
    expect(getStrategy("mock-agent")).toBe(mockStrategy);

    const command = process.platform === "win32" ? "cmd.exe" : "echo";
    const adapter: AdapterDef = {
      id: "mock-agent",
      command,
      label: "Mock Agent",
    };

    const handle = callAgentStream(adapter, "hello world");
    expect(handle.pty).toBeDefined();
    expect(handle.promise).toBeDefined();
    handle.promise.catch(() => {});
  });

  it("PTY path accepts the provider-failover seam but never invokes it", () => {
    const mockStrategy: AgentStrategy = {
      id: "mock-agent",
      buildArgs: () => ["--mock"],
      keepAlive: false,
      isComplete: (events: HookEvent[]) => events.some(e => e.type === "step_finish"),
      extractOutput: (out: string) => out.trim(),
    };

    registerStrategy(mockStrategy);

    const command = process.platform === "win32" ? "cmd.exe" : "echo";
    const adapter: AdapterDef = {
      id: "mock-agent",
      command,
      label: "Mock Agent",
    };

    const onProviderQuota = vi.fn(async () => undefined);
    const handle = callAgentStream(adapter, "hello world", undefined, undefined, undefined, undefined, undefined, onProviderQuota);
    expect(handle.pty).toBeDefined();
    expect(handle.promise).toBeDefined();
    handle.promise.catch(() => {});
    // A PTY agent has no providers/list or providers/set surface: the seam is
    // forwarded as inert and must never be consulted by this path.
    expect(onProviderQuota).not.toHaveBeenCalled();
  });
});
