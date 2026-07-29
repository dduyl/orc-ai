import { describe, it, expect } from "vitest";
import { BUILTIN_ADAPTERS } from "../../../application/agents/adapter.js";

describe("agents index", () => {
  it("exports BUILTIN_ADAPTERS", () => {
    expect(BUILTIN_ADAPTERS).toBeDefined();
    expect(Array.isArray(BUILTIN_ADAPTERS)).toBe(true);
  });
});
