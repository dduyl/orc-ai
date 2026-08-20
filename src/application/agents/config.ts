import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { log } from "../../core/log.js";

/** Model tier for a given agent role (ADR-021). */
export const TierSchema = z.enum(["cheap", "strong"]);
export type Tier = z.infer<typeof TierSchema>;

/** Per-role cheap/strong model overrides under `variants.<role>`. */
export const VariantsSchema = z.record(
  z.string(),
  z.object({
    cheap: z.string().optional(),
    strong: z.string().optional(),
  }),
);

/**
 * Per-provider block. `apiType`/`baseUrl`/`headers` configure a concrete
 * provider switch (consumed in Phase F); `tokenPaidApiKey` wins over the
 * top-level `tokenPaidApiKey` for that provider.
 */
export const ProvidersSchema = z.record(
  z.string(),
  z.object({
    apiType: z.string().optional(),
    baseUrl: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    tokenPaidApiKey: z.string().optional(),
  }),
);

/**
 * ADR-021 model-routing block read from `~/.orc/config.json`. Parsed
 * leniently: unknown keys (`provider`, `apiKey`, `model`,
 * `quotaPauseDelayMs`, ...) are ignored, and an absent or malformed file
 * yields `{}` so routing falls back to builtin defaults.
 */
export const ModelRoutingConfigSchema = z.object({
  variants: VariantsSchema.optional(),
  providers: ProvidersSchema.optional(),
  tokenPaidApiKey: z.string().optional(),
});
export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>;

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".orc", "config.json");
}

/**
 * Load the ADR-021 routing block from `~/.orc/config.json`.
 * Absent file / invalid JSON -> `{}`. Each top-level block
 * (`variants`, `providers`, `tokenPaidApiKey`) is parsed
 * independently: a malformed block is dropped and logged, but never
 * disables the other blocks (ADR-021 M5).
 */
export function loadModelRoutingConfig(configPath: string = defaultConfigPath()): ModelRoutingConfig {
  const result: ModelRoutingConfig = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return result;
    const obj = parsed as Record<string, unknown>;
    if (obj.variants !== undefined) {
      const r = VariantsSchema.safeParse(obj.variants);
      if (r.success) result.variants = r.data;
      else log.warn("loadModelRoutingConfig: dropping malformed 'variants' block", r.error);
    }
    if (obj.providers !== undefined) {
      const r = ProvidersSchema.safeParse(obj.providers);
      if (r.success) result.providers = r.data;
      else log.warn("loadModelRoutingConfig: dropping malformed 'providers' block", r.error);
    }
    if (obj.tokenPaidApiKey !== undefined) {
      const r = z.string().safeParse(obj.tokenPaidApiKey);
      if (r.success) result.tokenPaidApiKey = r.data;
      else log.warn("loadModelRoutingConfig: dropping malformed 'tokenPaidApiKey' block", r.error);
    }
  } catch {
    // absent file / invalid JSON / unreadable path -> {}
  }
  return result;
}
