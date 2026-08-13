import { describe, it, expect } from "vitest";
import { BUILTIN_ADAPTERS, getAdapter } from "../../../application/agents/adapter.js";

describe("agents/adapter", () => {
  it("has built-in adapters", () => {
    expect(BUILTIN_ADAPTERS.length).toBeGreaterThan(0);
    expect(getAdapter("opencode")).toBeDefined();
    expect(getAdapter("claude")).toBeDefined();
    expect(getAdapter("antigravity")).toBeDefined();
    expect(getAdapter("nonexistent")).toBeUndefined();
  });
});
