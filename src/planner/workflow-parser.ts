import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { basename, extname } from "node:path";
import { load as parseYaml } from "js-yaml";
import { WorkflowDefinition, type WorkflowDefinition as WD } from "../schemas.js";

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

export function yamlToWorkflowDef(yaml: any, id?: string): WD | null {
  try {
    const steps = (yaml.steps || []).map((s: any) => {
      const copy: Record<string, any> = { ...s };
      copy.depends_on = s.needs || s.depends_on || [];
      delete copy.needs;
      if (s.signal) {
        copy.signal = { ...s.signal };
        copy.signal.signal_on = s.signal.on ?? null;
        copy.signal.signal_off = s.signal.off ?? null;
        delete copy.signal.on;
        delete copy.signal.off;
      }
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
