import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeBinary } from "../../../../application/agents/acp/resolve.js";
import { spawn } from "cross-spawn";

const origPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = origPath;
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "orc-acp-resolve-"));
}

/** Seed a runnable file into a fresh temp dir and return the dir. */
function seed(name: string, content = "x"): string {
  const dir = tempDir();
  const p = join(dir, name);
  writeFileSync(p, content);
  if (process.platform !== "win32") chmodSync(p, 0o755);
  return dir;
}

describe("probeBinary", () => {
  it("returns true when the binary exists on PATH", () => {
    const name = process.platform === "win32" ? "probe-tool.exe" : "probe-tool";
    process.env.PATH = seed(name);
    expect(probeBinary("probe-tool", "test")).toBe(true);
  });

  it("returns false when absent", () => {
    process.env.PATH = seed("other-tool.exe");
    expect(probeBinary("definitely-not-on-path-xyz", "test")).toBe(false);
  });

  it("does not treat a bare extensionless shim as runnable on Windows", () => {
    if (process.platform !== "win32") return;
    process.env.PATH = seed("probe-tool", "#!/bin/sh");
    expect(probeBinary("probe-tool", "test")).toBe(false);
  });
});

describe("cross-spawn shim resolution", () => {
  it("resolves the .cmd shim (never the bare shim) and spawns without ENOENT on Windows", async () => {
    if (process.platform !== "win32") return;
    const dir = tempDir();
    writeFileSync(join(dir, "my-tool"), "#!/bin/sh");
    writeFileSync(join(dir, "my-tool.cmd"), "@echo off\r\n");
    process.env.PATH = dir;

    const child = spawn("my-tool", ["acp", "--pure"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", (err) =>
        reject(new Error(`expected .cmd shim to spawn, got: ${err.message}`)),
      );
      child.once("exit", () => resolve());
      setTimeout(() => reject(new Error("timed out waiting for .cmd shim to exit")), 5000);
    });
  });
});
