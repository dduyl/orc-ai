import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CommandExecutor,
  loadCommandsFile,
  resolveDottedKey,
  runCommandGroup,
  runInlineCommand,
  parseRun,
} from "../../../../application/harness/execution/CommandExecutor.js";
import { BuildResult } from "../../../../core/schemas.js";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `orc-cmdexec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = `[validate]
commands = ["echo ok"]

[test.unit]
commands = ["exit 3"]
`;

describe("loadCommandsFile", () => {
  it("parses a commands.toml into group->commands map", () => {
    const file = path.join(tmpDir(), "commands.toml");
    fs.writeFileSync(file, SAMPLE, "utf-8");
    const map = loadCommandsFile(file);
    expect(map["validate"]).toEqual(["echo ok"]);
    expect(map["test.unit"]).toEqual(["exit 3"]);
  });

  it("resolves dotted keys through nested toml tables", () => {
    const table = { test: { unit: { commands: ["x"] } } } as Record<string, unknown>;
    const v = resolveDottedKey(table, "test.unit");
    expect((v as Record<string, unknown>).commands).toEqual(["x"]);
  });

  it("returns empty map for a missing file", () => {
    expect(loadCommandsFile(path.join(tmpDir(), "nope.toml"))).toEqual({});
  });
});

describe("CommandExecutor", () => {
  it("parses exec run expressions into inline intents", () => {
    expect(parseRun('exec "node --check src/index.js"')).toEqual({
      ok: true,
      intent: { kind: "exec", command: "node --check src/index.js" },
    });
  });

  it("parses cmd run expressions into group-key intents", () => {
    expect(parseRun('cmd "test.unit"')).toEqual({
      ok: true,
      intent: { kind: "cmd", key: "test.unit" },
    });
  });

  it("rejects malformed run expressions", () => {
    expect(parseRun("test.unit").ok).toBe(false);
    expect(parseRun('cmd test.unit').ok).toBe(false);
    expect(parseRun('exec ""').ok).toBe(false);
    expect(parseRun("").ok).toBe(false);
  });

  it("executes an exec run expression through runInlineCommand", async () => {
    const exec = new CommandExecutor(path.join(tmpDir(), "empty.toml"));
    const r = await exec.execute('exec "exit 0"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.passed).toBe(true);
  });

  it("executes a cmd run expression through a named group", async () => {
    const file = path.join(tmpDir(), "commands.toml");
    fs.writeFileSync(file, `[ok]\ncommands = ["exit 0"]\n`, "utf-8");
    const exec = new CommandExecutor(file);
    const r = await exec.execute('cmd "ok"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.passed).toBe(true);
  });

  it("runs a named group and returns its exit code", async () => {
    const file = path.join(tmpDir(), "commands.toml");
    fs.writeFileSync(file, `[ok]\ncommands = ["exit 0"]\n`, "utf-8");
    const exec = new CommandExecutor(file);
    const res = await exec.run("ok");
    expect(res.passed).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it("short-circuits on the first failing command", async () => {
    const res = await runCommandGroup("grp", ["exit 0", "exit 7", "echo never"]);
    expect(res.passed).toBe(false);
    expect(res.exitCode).toBe(7);
    expect(res.groups).toHaveLength(2);
    expect(res.groups.map(g => g.command)).toEqual(["exit 0", "exit 7"]);
  });

  it("returns a failure for an unknown group", async () => {
    const exec = new CommandExecutor(path.join(tmpDir(), "empty.toml"));
    const res = await exec.run("nope");
    expect(res.passed).toBe(false);
    expect(res.exitCode).toBe(1);
  });

  it("runs an inline command via runInlineCommand", async () => {
    const res = await runInlineCommand("exit 0");
    expect(res.passed).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it("captures real stdout/stderr from the command", async () => {
    const res = await runCommandGroup("g", ["node -e \"console.log('hi'); console.error('err')\""]);
    expect(res.passed).toBe(true);
    expect(res.groups[0].stdout).toContain("hi");
    expect(res.groups[0].stderr).toContain("err");
    expect(res.groups[0].command).toBe("node -e \"console.log('hi'); console.error('err')\"");
  });

  it("rejects an empty inline command", async () => {
    const res = await runInlineCommand("");
    expect(res.passed).toBe(false);
  });

  it("conforms to the BuildResult schema", async () => {
    const res = await runInlineCommand("exit 0");
    expect(res.schemaVersion).toBe(1);
    expect(typeof res.passed).toBe("boolean");
    expect(typeof res.exitCode).toBe("number");
    expect(res.groups.every(g => typeof g.exitCode === "number" && typeof g.stdout === "string" && typeof g.stderr === "string")).toBe(true);
  });

  it("decodes through the BuildResult Zod schema", async () => {
    const res = await runInlineCommand("exit 0");
    expect(BuildResult.parse(res)).toEqual(res);
  });

  it("kills an in-flight command when the signal aborts", async () => {
    const ctrl = new AbortController();
    const p = runInlineCommand('node -e "setTimeout(() => {}, 5000)"', ctrl.signal);
    await new Promise(r => setTimeout(r, 150));
    const start = Date.now();
    ctrl.abort();
    await expect(p).rejects.toThrow("cancelled");
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(runInlineCommand("exit 0", ctrl.signal)).rejects.toThrow("cancelled");
  });
});