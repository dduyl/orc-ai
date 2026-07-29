import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "smol-toml";
import { log } from "../log.js";

export interface AgentPromptInfo {
  name: string;
  description: string;
  mode?: string;
}

export interface AgentOutputConfig {
  path: string;
  type: string;
}

export interface AgentSystemPrompt {
  systemPrompt: string;
  description: string;
  outputs: AgentOutputConfig[];
}

export function loadAgentSystemPrompts(agentsDir?: string): Map<string, AgentSystemPrompt> {
  const dir = agentsDir || join(homedir(), ".orc", "agents");
  const result = new Map<string, AgentSystemPrompt>();
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".toml"));
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), "utf-8");
        const parsed = parse(content) as Record<string, unknown>;
        log.debug(`[PromptLoader] parsed keys: ${Object.keys(parsed).join(", ")} for file ${file}`);
        log.debug(`[PromptLoader] prompt value type: ${typeof parsed.prompt}, length: ${(parsed.prompt as string || "").length}`);
        const name = parsed.name as string | undefined;
        if (!name) {
          log.warn(`[PromptLoader] Missing 'name' in ${file}`);
          continue;
        }
        const description = (parsed.description as string) || "";
        const outputs = (parsed.outputs as AgentOutputConfig[]) || [];
        const prompt = (parsed.prompt as string) || "";
        result.set(name, { systemPrompt: prompt, description, outputs });
      } catch {
        log.warn(`[PromptLoader] Failed to read ${file}`);
      }
    }
  } catch {
    log.warn(`[PromptLoader] Agents directory not found at ${dir}`);
  }
  return result;
}

export function loadAgentPrompts(agentsDir?: string): AgentPromptInfo[] {
  try {
    const prompts = loadAgentSystemPrompts(agentsDir);
    const result: AgentPromptInfo[] = [];
    for (const [name, p] of prompts) {
      result.push({ name, description: p.description });
    }
    return result;
  } catch {
    return [];
  }
}
