import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpClaude } from "../../../../application/agents/strategies/acp-claude.js";

const origPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = origPath;
});

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "orc-acp-claude-"));
  const p = join(dir, "claude-agent-acp" + (process.platform === "win32" ? ".cmd" : ""));
  writeFileSync(p, "");
  if (process.platform !== "win32") chmodSync(p, 0o755);
  return dir;
}

describe("acp-claude strategy", () => {
  it("is unavailable without claude-agent-acp → PTY fallback", () => {
    process.env.PATH = join(tmpdir(), "definitely-not-a-path");
    const strat = createAcpClaude();
    expect(strat.id).toBe("claude");
    expect(strat.available).toBe(false);
  });

  it("is available and builds the bare `claude-agent-acp` spec when the module is installed", () => {
    process.env.PATH = seed();

    const strat = createAcpClaude();
    expect(strat.available).toBe(true);
    expect(strat.label).toBe("claude-agent-acp");
    expect(strat.buildSpawn("/tmp/cwd")).toEqual({ command: "claude-agent-acp", args: [] });
  });
});
