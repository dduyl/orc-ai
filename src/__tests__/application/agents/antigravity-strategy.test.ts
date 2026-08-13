import { describe, it, expect } from "vitest";
import { antigravityStrategy } from "../../../application/agents/strategies/antigravity.js";
import { getStrategy } from "../../../application/agents/strategy.js";
import type { HookEvent } from "../../../core/hooks.js";

describe("agents/strategies/antigravity", () => {
  it("builds correct command arguments", () => {
    const args = antigravityStrategy.buildArgs("Test prompt");
    expect(args).toEqual(["--prompt", "Test prompt"]);
  });

  it("is registered under antigravity id", () => {
    const strategy = getStrategy("antigravity");
    expect(strategy).toBeDefined();
    expect(strategy.id).toBe("antigravity");
  });

  it("detects completion on stop event", () => {
    const events: HookEvent[] = [
      { type: "step_finish", timestamp: Date.now(), stepId: "test-step", reason: "stop" },
    ];
    expect(antigravityStrategy.isComplete(events)).toBe(true);
  });

  it("extracts output correctly", () => {
    const output = antigravityStrategy.extractOutput("Hello Antigravity");
    expect(output).toBe("Hello Antigravity");
  });
});
