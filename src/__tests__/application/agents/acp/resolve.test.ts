import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findInPath,
  needsShellWrapper,
  probeBinary,
  shellWrapIfNeeded,
} from "../../../../application/agents/acp/resolve.js";

const origPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = origPath;
});

function tempBin(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "orc-acp-resolve-"));
  writeFileSync(join(dir, name), "x");
  return dir;
}

describe("findInPath", () => {
  it("finds an executable on PATH", () => {
    const dir = tempBin("my-tool" + (process.platform === "win32" ? ".exe" : ""));
    process.env.PATH = dir;
    const found = findInPath("my-tool");
    expect(found).toBe(join(dir, "my-tool" + (process.platform === "win32" ? ".exe" : "")));
  });

  it("finds .cmd shims on Windows", () => {
    if (process.platform !== "win32") return;
    const dir = tempBin("my-tool.cmd");
    process.env.PATH = dir;
    expect(findInPath("my-tool")).toBe(join(dir, "my-tool.cmd"));
  });

  it("returns undefined when not found", () => {
    process.env.PATH = tempBin("other-tool.exe");
    expect(findInPath("definitely-not-on-path-xyz")).toBeUndefined();
  });
});

describe("needsShellWrapper / shellWrapIfNeeded", () => {
  it("detects .cmd/.bat shims on Windows", () => {
    if (process.platform !== "win32") return;
    expect(needsShellWrapper("C:\\tools\\opencode.cmd")).toBe(true);
    expect(needsShellWrapper("C:\\tools\\opencode.exe")).toBe(false);
    expect(needsShellWrapper("opencode")).toBe(false);
  });

  it("passes through non-shim commands unchanged", () => {
    const spec = shellWrapIfNeeded("node", ["--version"]);
    expect(spec).toEqual({ command: "node", args: ["--version"] });
  });

  it("wraps .cmd shims in cmd.exe on Windows", () => {
    if (process.platform !== "win32") return;
    const spec = shellWrapIfNeeded("C:\\tools\\opencode.cmd", ["acp", "--pure"]);
    expect(spec.command).toBe("cmd.exe");
    expect(spec.args[0]).toBe("/d");
    expect(spec.args[1]).toBe("/s");
    expect(spec.args[2]).toBe("/c");
  });
});

describe("probeBinary", () => {
  it("returns true when the binary exists on PATH", () => {
    const dir = tempBin("probe-tool" + (process.platform === "win32" ? ".exe" : ""));
    process.env.PATH = dir;
    expect(probeBinary("probe-tool", "test")).toBe(true);
  });

  it("returns false when absent", () => {
    process.env.PATH = tempBin("other-tool.exe");
    expect(probeBinary("definitely-not-on-path-xyz", "test")).toBe(false);
  });
});
