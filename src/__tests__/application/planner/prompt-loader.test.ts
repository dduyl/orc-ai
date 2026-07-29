import { describe, it, expect } from "vitest";
import { loadAgentSystemPrompts } from "../../../application/planner/prompt-loader.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("prompt-loader", () => {
  it("loads prompts from toml files", () => {
    const tmpDir = path.join(os.tmpdir(), `orc-prompt-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const tomlContent = `
name = "test_agent"
description = "Test agent description"
prompt = "You are a test agent."
`;
    fs.writeFileSync(path.join(tmpDir, "test_agent.toml"), tomlContent);

    const prompts = loadAgentSystemPrompts(tmpDir);
    expect(prompts.has("test_agent")).toBe(true);
    expect(prompts.get("test_agent")?.description).toBe("Test agent description");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
