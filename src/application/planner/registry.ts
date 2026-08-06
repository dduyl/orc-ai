import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { type WorkflowDefinition as WD } from "../../core/schemas.js";
import { loadYamlFile, loadJsonFile } from "./workflow-parser.js";

// Resolve the bundled builtin workflows directory under both environments:
// - dev / node (ESM): this module sits at dist/application/planner/, so the
//   builtins are ../../workflows from here.
// - packaged (pkg): the build copies src/workflows/*.yaml into dist/workflows/
//   and pkg embeds them as an asset mounted relative to the bundled entry
//   (dist/bundle.js). process.argv[1] under pkg is the snapshot entry path, so
//   the sibling workflows dir is reachable via its directory name.
function resolveBuiltinDir(): string {
  const isPkg = typeof process !== "undefined" && (process as { pkg?: unknown }).pkg;
  if (isPkg && typeof process !== "undefined" && process.argv?.[1]) {
    return join(dirname(process.argv[1]), "workflows");
  }
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows");
}

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

export class WorkflowRegistry {
  private workflows: Map<string, RegisteredWorkflow> = new Map();
  private dir: string;
  private builtinDir: string;

  constructor(opts?: { userDir?: string; builtinDir?: string }) {
    this.dir = opts?.userDir || join(homedir(), ".orc", "workflows");
    this.builtinDir = opts?.builtinDir || resolveBuiltinDir();
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
