import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

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
 * Absent file / invalid JSON / schema violations -> `{}`.
 */
export function loadModelRoutingConfig(configPath: string = defaultConfigPath()): ModelRoutingConfig {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return ModelRoutingConfigSchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}
