import { describe, it, expect } from "vitest";
import {
  classifyModels,
  modelTier,
  pickVariantModel,
  STRONG_PRICE_PER_M_INPUT,
  type ModelMeta,
  type ModelsSnapshot,
  type SnapshotModel,
} from "../../../application/agents/models.js";
import vendored from "../../../application/agents/models-snapshot.json";

function snap(
  providers: Record<string, Record<string, { reasoning?: boolean; tool_call?: boolean; cost?: number }>>,
): ModelsSnapshot {
  const out: ModelsSnapshot = {};
  for (const [pid, models] of Object.entries(providers)) {
    const m: Record<string, SnapshotModel> = {};
    for (const [mid, cfg] of Object.entries(models)) {
      m[mid] = {
        reasoning: cfg.reasoning,
        tool_call: cfg.tool_call,
        ...(cfg.cost !== undefined ? { cost: { input: cfg.cost } } : {}),
      };
    }
    out[pid] = { models: m };
  }
  return out;
}

const fixture = snap({
  configured: {
    expensive: { reasoning: true, tool_call: true, cost: 10 },
    strongBoundary: { reasoning: true, tool_call: true, cost: STRONG_PRICE_PER_M_INPUT },
    cheapish: { reasoning: true, tool_call: true, cost: 2.99 },
    free: { reasoning: true, tool_call: true, cost: 0 },
    unpricedStrong: { reasoning: true, tool_call: true },
    unpricedWeak: { reasoning: true, tool_call: false },
  },
  other: {
    onlyHere: { reasoning: true, tool_call: true, cost: 1 },
  },
});

describe("modelTier", () => {
  it("classifies a price exactly at the inclusive threshold as strong", () => {
    expect(modelTier({ id: "x", pricePerMInput: STRONG_PRICE_PER_M_INPUT, reasoning: true, toolCall: true, providers: [] })).toBe("strong");
  });

  it("classifies a price just below the threshold as cheap", () => {
    expect(modelTier({ id: "x", pricePerMInput: 2.99, reasoning: true, toolCall: true, providers: [] })).toBe("cheap");
  });

  it("classifies a price of 0 as cheap", () => {
    expect(modelTier({ id: "x", pricePerMInput: 0, reasoning: true, toolCall: true, providers: [] })).toBe("cheap");
  });

  it("falls back to capability when price is missing: strong requires reasoning && toolCall", () => {
    expect(modelTier({ id: "a", reasoning: true, toolCall: true, providers: [] })).toBe("strong");
    expect(modelTier({ id: "b", reasoning: true, toolCall: false, providers: [] })).toBe("cheap");
    expect(modelTier({ id: "c", reasoning: false, toolCall: true, providers: [] })).toBe("cheap");
  });
});

describe("classifyModels", () => {
  it("keeps only models offered by at least one configured provider", () => {
    const classified = classifyModels(fixture, ["configured"]);
    for (const id of ["expensive", "strongBoundary", "cheapish", "free", "unpricedStrong", "unpricedWeak"]) {
      expect(classified.has(id)).toBe(true);
    }
    expect(classified.has("onlyHere")).toBe(false);
  });

  it("merges models offered by several providers and records the provider set", () => {
    const s = snap({
      p1: { dup: { cost: 1 } },
      p2: { dup: { cost: 2 } },
    });
    const classified = classifyModels(s, ["p1", "p2"]);
    const meta = classified.get("dup")!;
    expect(meta.providers.sort()).toEqual(["p1", "p2"]);
  });

  it("drops a model the instant it has no configured provider", () => {
    const classified = classifyModels(fixture, ["other"]);
    expect(classified.has("onlyHere")).toBe(true);
    expect(classified.has("expensive")).toBe(false);
  });

  it("returns an empty map for an empty snapshot (and skips _meta)", () => {
    expect(classifyModels({ _meta: { source: "x" } }, ["configured"]).size).toBe(0);
  });

  it("carries price, reasoning and toolCall through from the snapshot", () => {
    const meta = classifyModels(fixture, ["configured"]).get("cheapish")!;
    expect(meta.pricePerMInput).toBe(2.99);
    expect(meta.reasoning).toBe(true);
    expect(meta.toolCall).toBe(true);
  });
});

describe("pickVariantModel", () => {
  function classifiedOf(...ids: [string, ModelMeta][]): Map<string, ModelMeta> {
    return new Map(ids);
  }

  it("honors the user override even when the model is not advertised", () => {
    const classified = classifiedOf(["expensive", { id: "expensive", pricePerMInput: 10, reasoning: true, toolCall: true, providers: ["configured"] }]);
    expect(pickVariantModel("cheap", ["expensive"], classified, "my-custom-model")).toBe("my-custom-model");
  });

  it("ignores a blank override and falls through to candidate selection", () => {
    const classified = classifyModels(fixture, ["configured"]);
    expect(pickVariantModel("cheap", ["free", "expensive"], classified, "  ")).toBe("free");
  });

  it("picks the cheapest strong candidate, breaking ties by advertised order", () => {
    const classified = classifiedOf(
      ["a", { id: "a", pricePerMInput: 10, reasoning: true, toolCall: true, providers: ["p"] }],
      ["b", { id: "b", pricePerMInput: 3, reasoning: true, toolCall: true, providers: ["p"] }],
      ["c", { id: "c", pricePerMInput: 3, reasoning: true, toolCall: true, providers: ["p"] }],
    );
    expect(pickVariantModel("strong", ["a", "b", "c"], classified)).toBe("b");
  });

  it("picks the cheapest cheap candidate", () => {
    const classified = classifyModels(fixture, ["configured"]);
    expect(pickVariantModel("cheap", ["cheapish", "free", "strongBoundary"], classified)).toBe("free");
  });

  it("falls back to the agent's default (first advertised classified id) when no candidate matches the tier", () => {
    const classified = classifyModels(fixture, ["configured"]);
    expect(pickVariantModel("strong", ["free"], classified)).toBe("free");
  });

  it("returns undefined, never throws, for empty advertised list / empty classified / fully filtered", () => {
    const classified = classifyModels(fixture, ["configured"]);
    expect(pickVariantModel("strong", [], classified)).toBeUndefined();
    expect(pickVariantModel("strong", ["free"], new Map())).toBeUndefined();
    expect(pickVariantModel("strong", ["onlyHere"], classified)).toBeUndefined();
    expect(pickVariantModel("strong", ["onlyHere"], classifyModels(fixture, ["configured"]))).toBeUndefined();
  });

  it("prefers an unpriced strong model over none when no priced strong exists", () => {
    const classified = classifyModels(fixture, ["configured"]);
    expect(pickVariantModel("strong", ["unpricedStrong"], classified)).toBe("unpricedStrong");
  });
});

describe("vendored models.dev snapshot", () => {
  const snapshot = vendored as unknown as ModelsSnapshot;

  it("records provenance (source, etag, fetch date)", () => {
    expect(snapshot._meta?.source).toBe("https://models.dev/api.json");
    expect(snapshot._meta?.etag).toBeTruthy();
    expect(snapshot._meta?.fetchedAt).toBeTruthy();
  });

  it("classifies real entries against a configured provider", () => {
    const classified = classifyModels(snapshot, ["anthropic"]);
    const sonnet = classified.get("claude-sonnet-4-5")!;
    const haiku = classified.get("claude-haiku-4-5")!;
    expect(modelTier(sonnet)).toBe("strong");
    expect(modelTier(haiku)).toBe("cheap");
    expect(classified.has("gpt-4o-mini")).toBe(false);
  });

  it("picks concrete tiers for a claude-style advertised list", () => {
    const classified = classifyModels(snapshot, ["anthropic"]);
    const advertised = ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"];
    expect(pickVariantModel("cheap", advertised, classified)).toBe("claude-haiku-4-5");
    expect(pickVariantModel("strong", advertised, classified)).toBe("claude-sonnet-4-5");
  });
});