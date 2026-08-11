import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpOpencode } from "../../../../application/agents/strategies/acp-opencode.js";

const origPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = origPath;
});

describe("acp-opencode strategy", () => {
  it("reports unavailable when opencode is not on PATH", () => {
    process.env.PATH = join(tmpdir(), "definitely-not-a-path");
    const strat = createAcpOpencode();
    expect(strat.available).toBe(false);
  });

  it("reports available and builds `opencode acp --pure` when found", () => {
    if (process.platform !== "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "orc-acp-opencode-"));
    writeFileSync(join(dir, "opencode.cmd"), "@echo off\r\n");
    process.env.PATH = dir;

    const strat = createAcpOpencode();
    expect(strat.id).toBe("opencode");
    expect(strat.available).toBe(true);
    expect(strat.label).toBe(join(dir, "opencode.cmd"));

    const spec = strat.buildSpawn("C:\\some\\cwd");
    expect(spec.command).toBe("cmd.exe");
    expect(spec.args.join(" ")).toContain("acp --pure");
    expect(spec.args.join(" ")).toContain("opencode.cmd");
  });

  it("spawns the bare `opencode` command when only the name is known", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "orc-acp-opencode-"));
    writeFileSync(join(dir, "opencode"), "#!/bin/sh\n");
    process.env.PATH = dir;

    const strat = createAcpOpencode();
    expect(strat.available).toBe(true);
    expect(strat.buildSpawn("/tmp/cwd")).toEqual({
      command: join(dir, "opencode"),
      args: ["acp", "--pure"],
    });
  });
});
