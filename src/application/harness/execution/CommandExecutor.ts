import { exec } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseToml } from "toml";

export interface ResultGroup {
  name: string;
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
    groups.push({ name, exitCode, stdout, stderr });
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
      return { schemaVersion: 1, passed: false, exitCode: 1, groups: [{ name: key, exitCode: 1, stdout: "", stderr: `Unknown command group: ${key}` }] };
    }
    return runCommandGroup(key, commands);
  }

  /** Run an inline command (one-off, not from commands.toml). */
  async runInline(command: string): Promise<CommandExecutionResult> {
    if (!command || command.length === 0) {
      return { schemaVersion: 1, passed: false, exitCode: 1, groups: [{ name: "inline", exitCode: 1, stdout: "", stderr: "Empty inline command" }] };
    }
    return runCommandGroup("inline", [command]);
  }
}