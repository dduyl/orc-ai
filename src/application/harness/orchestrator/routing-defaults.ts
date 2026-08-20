import type { ModelRoutingConfig } from "../../agents/config.js";
import { classifyModels, modelTier, MODELS_SNAPSHOT, selectVariantModel, type ModelsSnapshot } from "../../agents/models.js";
import type { OnProviderQuota, ProviderFailoverResult } from "../../agents/acp/types.js";

/**
 * ADR-021/ADR-022 production defaults for the quota-ladder seams, wired by
 * `orchestrate` (see orchestrator.ts). They give the combined ladder its
 * provider-failover and tier-downgrade rungs in real runs — previously those
 * rungs only existed when tests injected the seams.
 */

/**
 * FN2: the production default for the step-handler `resolveDowngradeModel`
 * seam — a strong->cheap downgrade derived from the user's model-routing
 * config, with no seam injection. Consulted at most once per step when a
 * quota error leaves the provider-failover path unused.
 *
 * Order:
 *  1. user override `variants.<role>.cheap` — honored even when the model is
 *     not in the agent's advertised list (the harness cannot see that list
 *     here), matching the ADR-021 override-first decision;
 *  2. the model in effect already classified "cheap" -> undefined (strong->cheap
 *     only; nothing to downgrade to);
 *  3. the cheapest-of-tier "cheap" model offered by a configured provider
 *     (pricePerMInput ascending), else undefined.
 *
 * `configuredProviders` is produced once per run (routing config `providers`
 * block + opencode auth.json) and shared with the failover seam.
 */
export function defaultResolveDowngradeModel(
  routingConfig: ModelRoutingConfig,
  configuredProviders: string[],
  snapshot: ModelsSnapshot = MODELS_SNAPSHOT,
): (role: string, triedModel: string) => string | undefined {
  const classified = classifyModels(snapshot, configuredProviders);
  return (role, triedModel) => {
    const override = routingConfig.variants?.[role]?.cheap?.trim();
    if (override && override !== triedModel) return override;
    const tried = classified.get(triedModel);
    if (tried && modelTier(tried) === "cheap") return undefined;
    const cheap = [...classified.values()]
      .filter(m => modelTier(m) === "cheap")
      .sort((a, b) => (a.pricePerMInput ?? Infinity) - (b.pricePerMInput ?? Infinity));
    const best = cheap[0];
    if (!best || best.id === triedModel) return undefined;
    return best.id;
  };
}

/**
 * H1: the production default for the ACP `onProviderQuota` seam. Switches the
 * session to the first provider the agent offers (via `providers/list`) that
 * the user has configured (routing `providers` block / opencode auth.json) and
 * that is not the provider currently in effect. The switch payload honors the
 * provider's `{ apiType, baseUrl, headers }` config block, falling back to the
 * advertised `current`; the model is re-resolved for the turn's tier via
 * `selectVariantModel`. Returns undefined when no candidate provider remains,
 * leaving the quota error to the downgrade/pause ladder.
 */
export function defaultOnProviderQuota(
  routingConfig: ModelRoutingConfig,
  configuredProviders: string[],
): OnProviderQuota {
  return async (router, context) => {
    const providers = await router.listProviders();
    const current = providers.find(p => p.current)?.providerId;
    const configured = new Set(configuredProviders);
    const candidate = providers.find(p => configured.has(p.providerId) && p.providerId !== current);
    if (!candidate) return undefined;

    const cfg = routingConfig.providers?.[candidate.providerId];
    await router.setProvider({
      providerId: candidate.providerId,
      apiType: cfg?.apiType ?? candidate.current?.apiType ?? "openai",
      baseUrl: cfg?.baseUrl ?? candidate.current?.baseUrl ?? "",
      ...(cfg?.headers ? { headers: cfg.headers } : {}),
    });

    const result: ProviderFailoverResult = { providerId: candidate.providerId };
    if (context.tier) {
      const model = selectVariantModel(
        context.tier,
        context.advertised,
        configuredProviders,
        MODELS_SNAPSHOT,
        context.variantModel,
      );
      if (model) result.model = model;
    }
    return result;
  };
}