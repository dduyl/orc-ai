import { describe, it, expect } from "vitest";
import { antigravityStrategy } from "../../../application/agents/strategies/antigravity.js";
import { opencodeStrategy } from "../../../application/agents/strategies/opencode.js";
import { claudeStrategy } from "../../../application/agents/strategies/claude.js";
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

  it("ignores the requested model (no CLI flag), so no supportsModel flag", () => {
    expect(antigravityStrategy.buildArgs("p", "my-model")).toEqual(["--prompt", "p"]);
    expect(antigravityStrategy.supportsModel).toBeUndefined();
  });
});

describe("agents/strategies/model flags", () => {
  it("opencode appends --model when a concrete model is supplied", () => {
    expect(opencodeStrategy.buildArgs("p")).toEqual(["--pure", "--prompt", "p"]);
    expect(opencodeStrategy.buildArgs("p", "claude-sonnet-4-6")).toEqual(["--pure", "--prompt", "p", "--model", "claude-sonnet-4-6"]);
    expect(opencodeStrategy.supportsModel).toBe(true);
  });

  it("claude appends --model when a concrete model is supplied", () => {
    expect(claudeStrategy.buildArgs("p")).toEqual(["--prompt", "p"]);
    expect(claudeStrategy.buildArgs("p", "claude-sonnet-4-6")).toEqual(["--prompt", "p", "--model", "claude-sonnet-4-6"]);
    expect(claudeStrategy.supportsModel).toBe(true);
  });
});
