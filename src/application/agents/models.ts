import type { Tier } from "./config.js";
import snapshot from "./models-snapshot.json";

/**
 * Strong-tier input-price threshold, inclusive: a model whose $/1M input
 * price is >= STRONG_PRICE_PER_M_INPUT is a strong-tier model.
 */
export const STRONG_PRICE_PER_M_INPUT = 3.0;

/**
 * A model entry in the vendored models.dev snapshot. Subset of the real
 * schema (https://models.dev/api.json): only the fields orc consumes.
 */
export interface SnapshotModel {
  reasoning?: boolean;
  tool_call?: boolean;
  cost?: { input?: number };
}

export interface SnapshotProvider {
  models: Record<string, SnapshotModel>;
}

/** Provenance block recorded in the vendored snapshot (`_meta`). */
export interface ModelsSnapshotMeta {
  source?: string;
  etag?: string;
  fetchedAt?: string;
}

/**
 * The vendored snapshot (src/application/agents/models-snapshot.json): a
 * record of provider id -> provider, plus a `_meta` provenance block that
 * never collides with a provider id.
 */
export interface ModelsSnapshot {
  _meta?: ModelsSnapshotMeta;
  [providerId: string]: SnapshotProvider | ModelsSnapshotMeta | undefined;
}

/** Classification of a single model id for ADR-021 tier selection. */
export interface ModelMeta {
  id: string;
  /** $/1M input tokens; undefined when the snapshot lacks pricing. */
  pricePerMInput?: number;
  reasoning: boolean;
  toolCall: boolean;
  /** Providers in the snapshot offering this model. */
  providers: string[];
}

/**
 * Tier of a single model: priced models use the inclusive price threshold;
 * unpriced models fall back to capability (strong requires both reasoning and
 * tool call). Price 0 -> cheap (0 < STRONG_PRICE_PER_M_INPUT).
 */
export function modelTier(meta: ModelMeta): Tier {
  const price = meta.pricePerMInput;
  if (price === undefined) return meta.reasoning && meta.toolCall ? "strong" : "cheap";
  return price >= STRONG_PRICE_PER_M_INPUT ? "strong" : "cheap";
}

function isSnapshotProvider(
  entry: SnapshotProvider | ModelsSnapshotMeta | undefined,
): entry is SnapshotProvider {
  return !!entry && "models" in entry;
}

/**
 * Flatten the snapshot into a model-id -> ModelMeta map, merging models that
 * are offered by several providers. Only models offered by >=1 of
 * `configuredProviders` survive (ADR-021 provider filter).
 */
export function classifyModels(
  snapshot: ModelsSnapshot,
  configuredProviders: string[],
): Map<string, ModelMeta> {
  const configured = new Set(configuredProviders);
  const out = new Map<string, ModelMeta>();
  for (const [providerId, provider] of Object.entries(snapshot)) {
    if (providerId === "_meta" || !isSnapshotProvider(provider)) continue;
    for (const [modelId, m] of Object.entries(provider.models)) {
      const existing = out.get(modelId);
      if (existing) {
        existing.providers.push(providerId);
        continue;
      }
      out.set(modelId, {
        id: modelId,
        pricePerMInput: m.cost?.input,
        reasoning: m.reasoning === true,
        toolCall: m.tool_call === true,
        providers: [providerId],
      });
    }
  }
  for (const [modelId, meta] of out) {
    if (!meta.providers.some(p => configured.has(p))) out.delete(modelId);
  }
  return out;
}

/**
 * Pick the concrete model for a tier (ADR-021). Order:
 *  1. user override (`variants.<agent>.<tier>`) — honored even when the model
 *     is NOT in the agent's advertised list;
 *  2. cheapest-of-tier among the advertised ids present in `classified`
 *     (advertised order is the tie-breaker);
 *  3. the agent's default — first advertised id present in `classified`
 *     (any tier), as a fallback;
 *  4. `undefined`.
 * The provider filter already ran inside `classifyModels`, so a candidate in
 * `classified` is guaranteed to be offered by a configured provider; the metas
 * still carry the full provider set for callers that want it.
 */
export function pickVariantModel(
  tier: Tier,
  agentAdvertised: string[],
  classified: Map<string, ModelMeta>,
  userOverride?: string,
): string | undefined {
  const override = userOverride?.trim();
  if (override) return override;
  const candidates = agentAdvertised.filter(id => classified.has(id));
  const tiered = candidates.filter(id => modelTier(classified.get(id)!) === tier);
  if (tiered.length > 0) {
    return [...tiered].sort((a, b) => {
      const pa = classified.get(a)!.pricePerMInput ?? Infinity;
      const pb = classified.get(b)!.pricePerMInput ?? Infinity;
      return pa - pb;
    })[0];
  }
  if (candidates.length > 0) return candidates[0];
  return undefined;
}

/**
 * The vendored models.dev snapshot as a typed constant. Runtime seams (the ACP
 * session model selection) import this so they never touch the raw JSON.
 */
export const MODELS_SNAPSHOT: ModelsSnapshot = snapshot as ModelsSnapshot;

/**
 * Convenience wrapper for the ACP session seam (ADR-021): classify the
 * snapshot against `configuredProviders`, then pick the cheapest-of-tier
 * advertised model (or the user override). `undefined` means "no usable
 * candidate" — the caller proceeds with the agent's default model.
 */
export function selectVariantModel(
  tier: Tier,
  agentAdvertised: string[],
  configuredProviders: string[],
  snapshot: ModelsSnapshot = MODELS_SNAPSHOT,
  userOverride?: string,
): string | undefined {
  return pickVariantModel(
    tier,
    agentAdvertised,
    classifyModels(snapshot, configuredProviders),
    userOverride,
  );
}
