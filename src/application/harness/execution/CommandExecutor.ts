import { exec } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseToml } from "toml";

export interface ResultGroup {
  /** Group name (or "inline" for ad-hoc commands). */
  name: string;
  /** The exact command text whose output this group captures. */
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandExecutionResult {
  schemaVersion: 1;
  passed: boolean;
  exitCode: number;
  groups: ResultGroup[];
}

export type CommandsMap = Record<string, string[]>;

/** Resolves a dotted key ("test.unit") through nested toml tables. */
export function resolveDottedKey(table: Record<string, unknown>, key: string): unknown {
  const segments = key.split(".");
  let cursor: Record<string, unknown> = table;
  for (const seg of segments) {
    const next = cursor[seg];
    if (next === undefined || next === null || typeof next !== "object") return undefined;
    cursor = next as Record<string, unknown>;
  }
  return cursor;
}

function toCommandsFromValue(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return [v];
  if (v !== null && typeof v === "object" && "commands" in v) {
    const cmds = (v as { commands?: unknown }).commands;
    if (Array.isArray(cmds)) return cmds.map(String);
    if (typeof cmds === "string") return [cmds];
  }
  return undefined;
}

/** Loads and parses commands.toml into a map of group key -> command list. */
export function loadCommandsFile(filePath: string): CommandsMap {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf-8");
  const parsed: Record<string, unknown> = parseToml(raw);
  const out: CommandsMap = {};

  function walk(table: Record<string, unknown>, prefix: string): void {
    for (const key of Object.keys(table)) {
      const value = table[key];
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value) && "commands" in value) {
        const resolved = toCommandsFromValue(value);
        if (resolved) out[fullKey] = resolved;
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, fullKey);
      } else {
        const resolved = toCommandsFromValue(value);
        if (resolved) out[fullKey] = resolved;
      }
    }
  }
  walk(parsed, "");
  return out;
}

const MAX_BUFFER = 16 * 1024 * 1024;

function runCommand(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!command || command.trim().length === 0) {
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Empty command" });
  }
  return new Promise(resolve => {
    exec(command, { encoding: "utf-8", maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      const exitCode = err && typeof (err as { code?: unknown }).code === "number"
        ? (err as { code: number }).code
        : err
          ? 1
          : 0;
      resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * Executes a command group deterministically from a resolved command list.
 * Runs sequentially and short-circuits on the first non-zero exit,
 * recording every group result encountered.
 */
export async function runCommandGroup(
  name: string,
  commands: string[],
): Promise<CommandExecutionResult> {
  const groups: ResultGroup[] = [];
  for (const command of commands) {
    const { exitCode, stdout, stderr } = await runCommand(command);
    groups.push({ name, command, exitCode, stdout, stderr });
    if (exitCode !== 0) break;
  }
  const failed = groups.find(g => g.exitCode !== 0);
  const exitCode = failed ? failed.exitCode : 0;
  return { schemaVersion: 1, passed: exitCode === 0, exitCode, groups };
}

/** Runs a single inline command as an ad hoc group. */
export async function runInlineCommand(command: string): Promise<CommandExecutionResult> {
  return runCommandGroup("inline", [command]);
}

export type RunIntent =
  | { kind: "cmd"; key: string }
  | { kind: "exec"; command: string };

// Matches a fully-quoted double-quoted argument that may contain escaped chars.
// Group 2 = the raw inner content (between the mandatory surrounding quotes).
const QUOTED = /^(cmd|exec)\s+"((?:\\.|[^"\\])*)"\s*$/;

/**
 * Parse a script step's `run` expression into a dispatchable intent.
 * Valid shapes:
 * - `cmd "group.key"`  — reference a named command group in `commands.toml`
 * - `exec "literal shell command"` — run a literal shell command string
 * The argument MUST be a single double-quoted string; escaped chars (`\"`, `\\`)
 * are honoured. Anything else (bare path, unquoted arg, empty, stray text) → `ok: false`.
 */
export function parseRun(run: string): { ok: true; intent: RunIntent } | { ok: false; error: string } {
  if (!run || run.trim().length === 0) {
    return { ok: false, error: "empty run expression" };
  }
  const m = run.trim().match(QUOTED);
  const kind = m?.[1] as "cmd" | "exec" | undefined;
  const raw = m?.[2] ?? "";
  if (!kind) {
    return { ok: false, error: `malformed run expression '${run}' — expected cmd "..." or exec "..."` };
  }
  if (raw.length === 0) {
    return { ok: false, error: `run expression '${run}' has an empty argument` };
  }
  const argument = unescapeQuoted(raw);
  if (kind === "exec") {
    return { ok: true, intent: { kind: "exec", command: argument } };
  }
  return { ok: true, intent: { kind: "cmd", key: argument } };
}

/** Decode the captured body by unescaping `\"` and `\\` (no other escapes). */
function unescapeQuoted(raw: string): string {
  return raw.replace(/\\(["\\])/g, "$1");
}

export class CommandExecutor {
  private commands: CommandsMap;

  constructor(private commandsPath?: string) {
    this.commands = this.commandsPath ? loadCommandsFile(this.commandsPath) : {};
  }

  get groupKeys(): string[] {
    return Object.keys(this.commands);
  }

  /** Run a named group declared in commands.toml. */
  async run(key: string): Promise<CommandExecutionResult> {
    const commands = this.commands[key];
    if (!commands || commands.length === 0) {
      return { schemaVersion: 1, passed: false, exitCode: 1, groups: [{ name: key, command: key, exitCode: 1, stdout: "", stderr: `Unknown command group: ${key}` }] };
    }
    return runCommandGroup(key, commands);
  }

  /** Run an inline command (one-off, not from commands.toml). */
  async runInline(command: string): Promise<CommandExecutionResult> {
    if (!command || command.length === 0) {
      return { schemaVersion: 1, passed: false, exitCode: 1, groups: [{ name: "inline", command: "", exitCode: 1, stdout: "", stderr: "Empty inline command" }] };
    }
    return runCommandGroup("inline", [command]);
  }

  /**
   * Dispatch a script step's `run` expression string. Returns `{ ok: false, error }`
   * for malformed expressions (a config error, hard-fails the step), otherwise the
   * execution result with a real exit code.
   */
  async execute(run: string): Promise<{ ok: false; error: string } | { ok: true; result: CommandExecutionResult }> {
    const parsed = parseRun(run);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const intent = parsed.intent;
    if (intent.kind === "exec") {
      return { ok: true, result: await this.runInline(intent.command) };
    }
    return { ok: true, result: await this.run(intent.key) };
  }
}