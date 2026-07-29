import { describe, it, expect } from "vitest";
import { BUILTIN_ADAPTERS, getAdapter, type AdapterDef, type AgentCallResult } from "../agents/adapter.js";

describe("BUILTIN_ADAPTERS", () => {
  it("contains opencode and claude", () => {
    const ids = BUILTIN_ADAPTERS.map(a => a.id);
    expect(ids).toContain("opencode");
    expect(ids).toContain("claude");
  });

  it("each adapter has id, command, label", () => {
    for (const a of BUILTIN_ADAPTERS) {
      expect(typeof a.id).toBe("string");
      expect(typeof a.command).toBe("string");
      expect(typeof a.label).toBe("string");
      expect(a.id.length).toBeGreaterThan(0);
      expect(a.command.length).toBeGreaterThan(0);
      expect(a.label.length).toBeGreaterThan(0);
    }
  });
});

describe("getAdapter", () => {
  it("returns opencode adapter", () => {
    const a = getAdapter("opencode");
    expect(a).toBeDefined();
    expect(a!.id).toBe("opencode");
  });

  it("returns claude adapter", () => {
    const a = getAdapter("claude");
    expect(a).toBeDefined();
    expect(a!.id).toBe("claude");
  });

  it("returns undefined for unknown adapter", () => {
    expect(getAdapter("unknown")).toBeUndefined();
  });
});
