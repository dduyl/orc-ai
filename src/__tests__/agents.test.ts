import { describe, it, expect } from "vitest";
import type { AgentCallResult } from "../agents/adapter.js";

describe("AgentCallResult", () => {
  it("accepts valid result shape", () => {
    const result: AgentCallResult = { content: "{}", model: "mock", tokensUsed: 0, duration: 0 };
    expect(result.content).toBe("{}");
    expect(result.model).toBe("mock");
    expect(result.tokensUsed).toBe(0);
    expect(result.duration).toBe(0);
  });
});
