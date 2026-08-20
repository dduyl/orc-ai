import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRoutingConfig } from "./config.js";

/**
 * Path to opencode's auth.json (XDG data dir). Its top-level keys name the
 * providers the user has credentials for — one input to the ADR-021 provider
 * filter. A missing or unreadable file is tolerated (contributes nothing).
 */
export function opencodeAuthPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

/**
 * Providers the user has credentials for (ADR-021 provider filter input):
 * the user config `providers` block keys plus opencode's auth.json provider
 * keys. The ACP `providers/list` source is layered on in a later phase; for
 * now the harness produces this once per run and threads it through the agent
 * call so the ACP session seam can classify against the same provider set.
 */
export function readConfiguredProviders(
  routingConfig: ModelRoutingConfig,
  authPath: string = opencodeAuthPath(),
): string[] {
  const providers = new Set<string>();
  if (routingConfig.providers) {
    for (const providerId of Object.keys(routingConfig.providers)) providers.add(providerId);
  }
  try {
    const auth: unknown = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (auth && typeof auth === "object") {
      for (const providerId of Object.keys(auth as Record<string, unknown>)) providers.add(providerId);
    }
  } catch {
    /* missing/unreadable auth.json: not a source of configured providers */
  }
  return [...providers];
}
