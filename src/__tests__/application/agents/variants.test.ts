import { describe, it, expect } from "vitest";
import { resolveVariantTier, BUILTIN_TIERED_ROLES } from "../../../application/agents/variants.js";

describe("resolveVariantTier", () => {
  it("defaults an untiered role to strong (never under-provision)", () => {
    expect(resolveVariantTier("codegen", "simple", {})).toBe("strong");
    expect(resolveVariantTier("codegen", "complex", {})).toBe("strong");
  });

  it("defaults to strong when the config block is absent", () => {
    expect(resolveVariantTier("architect", "simple")).toBe("strong");
  });

  it("routes a user-configured role to cheap on simple complexity", () => {
    const config = { variants: { codegen: { cheap: "gpt-4o-mini", strong: "gpt-5" } } };
    expect(resolveVariantTier("codegen", "simple", config)).toBe("cheap");
  });

  it("routes a user-configured role to strong on complex complexity", () => {
    const config = { variants: { codegen: { cheap: "gpt-4o-mini", strong: "gpt-5" } } };
    expect(resolveVariantTier("codegen", "complex", config)).toBe("strong");
  });

  it("routes builtin tiered roles by complexity via the populated defaults", () => {
    expect(BUILTIN_TIERED_ROLES).toContain("architecture_agent");
    expect(resolveVariantTier("architecture_agent", "simple", {})).toBe("cheap");
    expect(resolveVariantTier("architecture_agent", "complex", {})).toBe("strong");
    expect(resolveVariantTier("review", "complex", {})).toBe("strong");
    expect(resolveVariantTier("code_generation_backend", "simple", {})).toBe("cheap");
  });

  it("covers the full canonical builtin prompt set", () => {
    expect([...BUILTIN_TIERED_ROLES].sort()).toEqual(
      [
        "architecture_agent",
        "code_generation_backend",
        "code_generation_frontend",
        "requirement_analyst",
        "review",
        "test_generation_backend",
        "test_generation_frontend",
      ].sort(),
    );
  });

  it("keeps script steps out of tiering (script roles are never in the set)", () => {
    expect(BUILTIN_TIERED_ROLES.has("script")).toBe(false);
    expect(resolveVariantTier("script", "simple", {})).toBe("strong");
  });

  it("lets a user variants entry override the builtin default for the same role", () => {
    const config = { variants: { architecture_agent: { cheap: "gpt-4o-mini", strong: "gpt-5" } } };
    expect(resolveVariantTier("architecture_agent", "simple", config)).toBe("cheap");
    expect(resolveVariantTier("architecture_agent", "complex", config)).toBe("strong");
  });

  it("ignores a variants block that does not name this role", () => {
    const config = { variants: { other: { cheap: "a", strong: "b" } } };
    expect(resolveVariantTier("codegen", "simple", config)).toBe("strong");
  });

  it("uses the complexity signal, not the role name, to split a tiered role", () => {
    const config = { variants: { reviewer: { cheap: "a", strong: "b" } } };
    expect(resolveVariantTier("reviewer", "simple", config)).toBe("cheap");
    expect(resolveVariantTier("reviewer", "complex", config)).toBe("strong");
  });

  it("does not throw on a partial variants entry", () => {
    const config = { variants: { codegen: { cheap: "gpt-4o-mini" } } };
    expect(resolveVariantTier("codegen", "simple", config)).toBe("cheap");
    expect(resolveVariantTier("codegen", "complex", config)).toBe("strong");
  });

  it("treats an empty variants entry as configured (routes by complexity)", () => {
    const config = { variants: { codegen: {} } };
    expect(resolveVariantTier("codegen", "simple", config)).toBe("cheap");
    expect(resolveVariantTier("codegen", "complex", config)).toBe("strong");
  });
});