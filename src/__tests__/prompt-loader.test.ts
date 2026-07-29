import { describe, it, expect } from "vitest";
import { loadAgentPrompts, loadAgentSystemPrompts } from "../planner/prompt-loader.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function tmpAgentsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-agents-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const sampleAnalysist = [
  'name = "requirement_analyst"',
  'description = "Use this agent when a raw request needs to be formalized into a structured specification before implementation."',
  "",
  'prompt = """',
  "You are a senior business analyst...",
  '"""',
  "",
  "[[outputs]]",
  'path = ".agents/requirements/{workflowId}-spec.md"',
  'type = "artifact"',
].join("\n");

const sampleBackendCodegen = [
  'name = "code_generation_backend"',
  'description = "Use this agent when implementing backend code that must adhere to a specific contract."',
  'prompt = """',
  "You are a senior backend engineer...",
  '"""',
].join("\n");

const sampleUnknown = [
  'description = "Some unknown agent."',
  'prompt = "Nothing important."',
].join("\n");

describe("loadAgentSystemPrompts", () => {
  it("returns system prompt body and description", () => {
    const dir = tmpAgentsDir({
      "analysist.toml": sampleAnalysist,
      "backend-codegen.toml": sampleBackendCodegen,
    });
    const prompts = loadAgentSystemPrompts(dir);
    expect(prompts.size).toBe(2);

    const ra = prompts.get("requirement_analyst");
    expect(ra).toBeDefined();
    expect(ra!.description).toContain("raw request needs to be formalized");
    expect(ra!.systemPrompt).toContain("senior business analyst");
    expect(ra!.outputs).toHaveLength(1);
    expect(ra!.outputs[0].path).toContain("{workflowId}");

    const cb = prompts.get("code_generation_backend");
    expect(cb).toBeDefined();
    expect(cb!.systemPrompt).toContain("senior backend engineer");
    expect(cb!.outputs).toEqual([]);
  });

  it("skips files without a name field", () => {
    const dir = tmpAgentsDir({
      "analysist.toml": sampleAnalysist,
      "unknown-agent.toml": sampleUnknown,
    });
    const prompts = loadAgentSystemPrompts(dir);
    expect(prompts.size).toBe(1);
    expect(prompts.has("requirement_analyst")).toBe(true);
  });

  it("returns empty map when directory does not exist", () => {
    const result = loadAgentSystemPrompts("C:\\nonexistent\\agents");
    expect(result.size).toBe(0);
  });
});

describe("loadAgentPrompts", () => {
  it("loads mapped agents and returns their descriptions", () => {
    const dir = tmpAgentsDir({
      "analysist.toml": sampleAnalysist,
      "backend-codegen.toml": sampleBackendCodegen,
    });
    const result = loadAgentPrompts(dir);
    expect(result.length).toBe(2);

    const reqAnalyst = result.find(a => a.name === "requirement_analyst");
    expect(reqAnalyst).toBeDefined();
    expect(reqAnalyst!.description).toContain("raw request needs to be formalized");

    const codegen = result.find(a => a.name === "code_generation_backend");
    expect(codegen).toBeDefined();
    expect(codegen!.description).toContain("implementing backend code");
  });

  it("returns empty array when directory does not exist", () => {
    const result = loadAgentPrompts("C:\\nonexistent\\agents");
    expect(result).toEqual([]);
  });

  it("returns empty array for empty directory", () => {
    const dir = tmpAgentsDir({});
    const result = loadAgentPrompts(dir);
    expect(result).toEqual([]);
  });
});
