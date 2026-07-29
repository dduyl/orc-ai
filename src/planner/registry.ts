import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { WorkflowDefinition, type WorkflowDefinition as WD } from "../schemas.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface RegisteredWorkflow {
  id: string;
  name: string;
  filePath: string;
  definition: WD;
}

export interface PlannerResult {
  workflow: WD;
  source: "registered" | "llm_classified" | "generated" | "dynamic";
  registration?: RegisteredWorkflow;
}

function loadYamlFile(filePath: string): WD | null {
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

function loadJsonFile(filePath: string): WD | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return WorkflowDefinition.parse(parsed);
  } catch {
    return null;
  }
}

function yamlToWorkflowDef(yaml: any, id?: string): WD | null {
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

export class WorkflowRegistry {
  private workflows: Map<string, RegisteredWorkflow> = new Map();
  private dir: string;
  private builtinDir: string;

  constructor(opts?: { userDir?: string; builtinDir?: string }) {
    this.dir = opts?.userDir || join(homedir(), ".orc", "workflows");
    this.builtinDir = opts?.builtinDir || join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");
  }

  loadAll(): RegisteredWorkflow[] {
    this.workflows.clear();

    // Load builtins first
    if (existsSync(this.builtinDir)) {
      const files = readdirSync(this.builtinDir).filter(f => /\.(yaml|yml)$/i.test(f));
      for (const file of files) {
        const filePath = join(this.builtinDir, file);
        const definition = loadYamlFile(filePath);
        if (definition) {
          this.workflows.set(definition.workflow.id, {
            id: definition.workflow.id,
            name: definition.workflow.name,
            filePath: "(builtin)",
            definition,
          });
        }
      }
    }

    // Load from user dir (JSON + YAML), overriding builtins with matching IDs if present
    if (existsSync(this.dir)) {
      const entries = readdirSync(this.dir);
      for (const file of entries) {
        const filePath = join(this.dir, file);
        const ext = extname(file).toLowerCase();
        let definition: WD | null = null;
        if (ext === ".yaml" || ext === ".yml") {
          definition = loadYamlFile(filePath);
        } else if (ext === ".json") {
          definition = loadJsonFile(filePath);
        }
        if (definition) {
          this.workflows.set(definition.workflow.id, {
            id: definition.workflow.id,
            name: definition.workflow.name,
            filePath,
            definition,
          });
        }
      }
    }

    return Array.from(this.workflows.values());
  }

  get(id: string): RegisteredWorkflow | undefined {
    return this.workflows.get(id);
  }

  findByName(name: string): RegisteredWorkflow | undefined {
    for (const w of this.workflows.values()) {
      if (w.name === name || w.id === name) return w;
    }
    return undefined;
  }

  list(): RegisteredWorkflow[] {
    return Array.from(this.workflows.values());
  }

  count(): number {
    return this.workflows.size;
  }

  saveDynamic(definition: WD): void {
    mkdirSync(this.dir, { recursive: true });
    const filePath = join(this.dir, `${definition.workflow.id}.json`);
    writeFileSync(filePath, JSON.stringify(definition, null, 2));
  }
}
