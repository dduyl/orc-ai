import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpClaude } from "../../../../application/agents/strategies/acp-claude.js";

const origPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = origPath;
});

describe("acp-claude strategy", () => {
  it("is unavailable without claude-agent-acp → PTY fallback", () => {
    process.env.PATH = join(tmpdir(), "definitely-not-a-path");
    const strat = createAcpClaude();
    expect(strat.id).toBe("claude");
    expect(strat.available).toBe(false);
  });

  it("is available and spawns claude-agent-acp when the module is installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-acp-claude-"));
    writeFileSync(join(dir, "claude-agent-acp" + (process.platform === "win32" ? ".cmd" : "")), "");
    process.env.PATH = dir;

    const strat = createAcpClaude();
    expect(strat.available).toBe(true);
    const spec = strat.buildSpawn("/tmp/cwd");
    if (process.platform === "win32") {
      expect(spec.command).toBe("cmd.exe");
      expect(spec.args.join(" ")).toContain("claude-agent-acp");
    } else {
      expect(spec).toEqual({ command: join(dir, "claude-agent-acp"), args: [] });
    }
  });
});
