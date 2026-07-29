import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { WorkflowDefinition, type WorkflowDefinition as WD } from "../schemas.js";
import { featureImplementation, issueToFix, bugfix } from "../workflows/index.js";

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

function registerBuiltin(rw: RegisteredWorkflow, map: Map<string, RegisteredWorkflow>) {
  if (!map.has(rw.id)) map.set(rw.id, rw);
}

export class WorkflowRegistry {
  private workflows: Map<string, RegisteredWorkflow> = new Map();
  private dir: string;

  constructor(customDir?: string) {
    this.dir = customDir || join(homedir(), ".orc", "workflows");
  }

  loadAll(): RegisteredWorkflow[] {
    this.workflows.clear();

    if (existsSync(this.dir)) {
      const entries = readdirSync(this.dir).filter(f => f.endsWith(".json"));
      for (const file of entries) {
        try {
          const filePath = join(this.dir, file);
          const raw = readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(raw);
          const definition = WorkflowDefinition.parse(parsed);
          const rw: RegisteredWorkflow = {
            id: definition.workflow.id,
            name: definition.workflow.name,
            filePath,
            definition,
          };
          this.workflows.set(rw.id, rw);
        } catch {
          continue;
        }
      }
    }

    // Fall back to builtins when user dir has no workflows
    if (this.workflows.size === 0) {
      registerBuiltin({ id: "feature_implementation", name: "Feature Implementation", filePath: "(builtin)", definition: featureImplementation }, this.workflows);
      registerBuiltin({ id: "issue_to_fix", name: "Issue to Fix", filePath: "(builtin)", definition: issueToFix }, this.workflows);
      registerBuiltin({ id: "bugfix", name: "Bugfix", filePath: "(builtin)", definition: bugfix }, this.workflows);
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
