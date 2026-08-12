import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcMethod, RpcNotification } from "../../../../application/harness/daemon/rpc-protocol.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

const REL_IMPORT = /(?:from\s+|import\(\s*)["'](\.[^"']+)["']\s*\)?/g;
const BARE_IMPORT = /(?:from\s+|import\(\s*)["']([^.'"][^"']*)["']\s*\)?/g;

/** Strip `import type` / `export type` statements (erased at emit → not runtime edges). */
function stripTypeOnly(source: string): string {
  return source
    .replace(/^\s*import\s+type\b[\s\S]*?;\s*$/gm, "")
    .replace(/^\s*export\s+type\b[\s\S]*?;\s*$/gm, "");
}

function importSpecifiers(source: string): { relative: string[]; bare: string[] } {
  const runtime = stripTypeOnly(source);
  const relative = new Set<string>();
  const bare = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = REL_IMPORT.exec(runtime)) !== null) relative.add(m[1]);
  while ((m = BARE_IMPORT.exec(runtime)) !== null) bare.add(m[1]);
  return { relative: [...relative], bare: [...bare] };
}

function sourcePath(fromFile: string, spec: string): string {
  const ts = spec.replace(/\.js$/, ".ts");
  const candidate = join(dirname(fromFile), ts);
  if (!existsSync(candidate)) {
    throw new Error(`unresolved relative import "${spec}" from ${fromFile}`);
  }
  return candidate;
}

function reachableSources(entries: string[]): { files: Set<string>; bare: Set<string> } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const file = resolve(stack.pop()!);
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const { relative, bare: b } = importSpecifiers(source);
    for (const spec of b) bare.add(spec);
    for (const spec of relative) stack.push(sourcePath(file, spec));
  }
  return { files: seen, bare };
}

/**
 * Guard test: the control-plane wire protocol lives in `rpc-protocol.ts` and
 * must never be re-homed into `daemon-server.ts`. The GUI (`daemon-bridge.ts`)
 * and `pipe-client.ts` must import it from there so neither pulls the daemon
 * graph into the Electron renderer's module tree (see ADR-025).
 */
describe("daemon/rpc-protocol", () => {
  it("exports the control-plane method-name constants", () => {
    expect(RpcMethod).toEqual({
      start: "start",
      list: "list",
      status: "status",
      cancel: "cancel",
      attach: "attach",
      stop: "stop",
      attachMain: "attachMain",
      input: "input",
      prompt: "prompt",
      cancelMain: "cancelMain",
      answerPermission: "answerPermission",
    });
    expect(RpcNotification).toEqual({
      progress: "progress",
      workflowComplete: "workflowComplete",
      permissionRequested: "permissionRequested",
    });
  });

  it("is type-only at runtime (no value imports from the daemon graph)", () => {
    const source = read("application/harness/daemon/rpc-protocol.ts");
    const importLines = source.split("\n").filter((l) => /^\s*import /.test(l));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line.trim()).toMatch(/^import\s+type\s/);
    }
  });

  it("pipe-client imports the protocol from rpc-protocol, never daemon-server", () => {
    const source = read("application/harness/daemon/pipe-client.ts");
    expect(source).not.toContain('from "./daemon-server.js"');
    expect(source).toContain('from "./rpc-protocol.js"');
    expect(source).toContain("RpcMethod");
    expect(source).toContain("RpcNotification");
  });

  it("daemon-bridge imports protocol types from rpc-protocol, never daemon-server", () => {
    const source = read("delivery/gui/daemon-bridge.ts");
    expect(source).not.toContain("daemon/daemon-server.js");
    expect(source).toContain("daemon/rpc-protocol.js");
    expect(source).toContain("WorkflowCompleteInfo");
  });

  it("the whole GUI source graph transitively excludes the daemon subtree", () => {
    const guiDir = resolve(SRC, "delivery/gui");
    const entries = readdirSync(guiDir).filter((f) => f.endsWith(".ts")).map((f) => join(guiDir, f));
    const { files, bare } = reachableSources(entries);

    expect(files.size).toBeGreaterThan(0);
    expect(files).toContain(resolve(SRC, "delivery/gui/main.ts"));
    expect(files).toContain(resolve(SRC, "application/harness/daemon/pipe-client.ts"));
    expect(files).toContain(resolve(SRC, "application/harness/daemon/rpc-protocol.ts"));

    const daemonServer = resolve(SRC, "application/harness/daemon/daemon-server.ts");
    expect(files).not.toContain(daemonServer);

    for (const heavy of ["@xterm/headless", "node-pty", "better-sqlite3", "node:sqlite"]) {
      expect(bare).not.toContain(heavy);
    }
  });
});
