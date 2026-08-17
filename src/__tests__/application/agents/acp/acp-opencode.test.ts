import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpOpencode } from "../../../../application/agents/strategies/acp-opencode.js";

const origPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = origPath;
});

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "orc-acp-opencode-"));
  const p = join(dir, process.platform === "win32" ? "opencode.cmd" : "opencode");
  writeFileSync(p, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  if (process.platform !== "win32") chmodSync(p, 0o755);
  return dir;
}

describe("acp-opencode strategy", () => {
  it("reports unavailable when opencode is not on PATH", () => {
    process.env.PATH = join(tmpdir(), "definitely-not-a-path");
    const strat = createAcpOpencode();
    expect(strat.available).toBe(false);
  });

  it("reports available and builds the bare `opencode acp --pure` spec when found", () => {
    process.env.PATH = seed();

    const strat = createAcpOpencode();
    expect(strat.id).toBe("opencode");
    expect(strat.available).toBe(true);
    expect(strat.label).toBe("opencode");
    expect(strat.buildSpawn("C:\\some\\cwd")).toEqual({
      command: "opencode",
      args: ["acp", "--pure"],
    });
  });
});
