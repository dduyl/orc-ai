import { readFileSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { load as parseYaml } from "js-yaml";
import { WorkflowDefinition, type WorkflowDefinition as WD } from "../../core/schemas.js";
import { log } from "../../core/log.js";

export function loadYamlFile(filePath: string): WD | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: any = parseYaml(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return yamlToWorkflowDef(parsed, basename(filePath, extname(filePath)));
  } catch {
    return null;
  }
}

export function loadJsonFile(filePath: string): WD | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return WorkflowDefinition.parse(parsed);
  } catch {
    return null;
  }
}

/** Old ADR-011 pre-signal edge keys that are silently ignored by the parser. */
const DEPRECATED_STEP_KEYS = ["needs", "depends_on", "signal"] as const;

export function yamlToWorkflowDef(yaml: any, id?: string): WD | null {
  try {
    const steps = (yaml.steps || []).map((s: any) => {
      const copy: Record<string, any> = { ...s };
      // ADR-011: the YAML *is* the graph — `emits`/`on`/`any` pass through verbatim.
      // No `needs`→`depends_on` or `signal.on/off` translation remains.
      const deprecated = DEPRECATED_STEP_KEYS.filter(k => k in s);
      if (deprecated.length > 0) {
        // F9: surface the migration instead of dropping the workflow silently.
        log.warn(
          `[workflow-parser] workflow '${yaml.id || id || "(unnamed)"}' step '${s.id}' uses deprecated ADR-011 key(s): ${deprecated.join(", ")}. ` +
          `Migrate to signal refs: define 'emits' and route with 'on' (ALL) or 'any' (ANY) using stepId.signalName.`,
        );
      }
      delete copy.needs;
      delete copy.depends_on;
      delete copy.signal;
      return copy;
    });

    const raw = {
      version: 1,
      workflow: {
        id: yaml.id || id,
        name: yaml.name,
        description: yaml.description,
        steps,
        completion: yaml.completion,
      },
    };
    return WorkflowDefinition.parse(raw);
  } catch (e: any) {
    return null;
  }
}
