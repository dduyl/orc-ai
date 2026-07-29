import { execSync } from "node:child_process";

export interface CommandGroup {
  commands: string[];
}

export interface CommandGroups {
  [key: string]: CommandGroup;
}

export interface CommandResult {
  name: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunResult {
  passed: boolean;
  exitCode: number;
  groups: CommandResult[];
}

export function parseCommandsToml(content: string): CommandGroups {
  const groups: CommandGroups = {};
  let currentKey = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const header = trimmed.match(/^\[([\w.]+)\]$/);
    if (header) {
      currentKey = header[1];
      continue;
    }
    if (trimmed.startsWith("commands")) {
      const listMatch = trimmed.match(/commands\s*=\s*\[([^\]]*)\]/);
      if (listMatch) {
        groups[currentKey] = {
          commands: listMatch[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean),
        };
      }
    }
  }
  return groups;
}

export class CommandExecutor {
  runGroup(group: CommandGroup, cwd: string, groupName: string): CommandResult {
    let exitCode = 0;
    let stdout = "";
    let stderr = "";

    for (const cmd of group.commands) {
      try {
        const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000 });
        stdout += output;
      } catch (err: any) {
        exitCode = err.status ?? 1;
        stderr += err.stderr ?? err.message ?? "";
        if (err.stdout) stdout += err.stdout;
        break;
      }
    }

    return { name: groupName, exitCode, stdout, stderr };
  }

  runGroups(
    groups: CommandGroups,
    order: string[],
    cwd: string
  ): RunResult {
    const results: CommandResult[] = [];
    for (const name of order) {
      const group = groups[name];
      if (!group) {
        results.push({ name, exitCode: -1, stdout: "", stderr: `Group "${name}" not found in commands.toml` });
        return { passed: false, exitCode: -1, groups: results };
      }
      const result = this.runGroup(group, cwd, name);
      results.push(result);
      if (result.exitCode !== 0) {
        return { passed: false, exitCode: result.exitCode, groups: results };
      }
    }
    return { passed: true, exitCode: 0, groups: results };
  }
}
