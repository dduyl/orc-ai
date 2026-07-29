import { describe, it, expect } from "vitest";
import { CommandExecutor, parseCommandsToml, type CommandGroups } from "../harness/CommandExecutor.js";

describe("parseCommandsToml", () => {
  it("parses validate and test groups", () => {
    const input = `[validate]\ncommands = ["npm run lint", "npm run build"]\n\n[test.unit]\ncommands = ["npm run test:unit"]\n`;
    const result = parseCommandsToml(input);
    expect(result.validate).toBeDefined();
    expect(result.validate.commands).toEqual(["npm run lint", "npm run build"]);
    expect(result["test.unit"].commands).toEqual(["npm run test:unit"]);
  });

  it("ignores comments and empty lines", () => {
    const input = `# this is a comment\n\n[validate]\ncommands = ["echo ok"]\n`;
    const result = parseCommandsToml(input);
    expect(result.validate.commands).toEqual(["echo ok"]);
  });
});

describe("CommandExecutor", () => {
  const executor = new CommandExecutor();

  it("runs a command group successfully", () => {
    const result = executor.runGroup({ commands: ["echo hello"] }, process.cwd(), "echo_test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("captures non-zero exit code", () => {
    const result = executor.runGroup({ commands: ["node -e \"process.exit(1)\""] }, process.cwd(), "fail_test");
    expect(result.exitCode).toBe(1);
  });

  it("runs groups in order and short-circuits on failure", () => {
    const groups: CommandGroups = {
      pass: { commands: ["echo ok"] },
      fail: { commands: ["node -e \"process.exit(1)\""] },
      unreachable: { commands: ["echo unreachable"] },
    };
    const result = executor.runGroups(groups, ["pass", "fail", "unreachable"], process.cwd());
    expect(result.passed).toBe(false);
    expect(result.groups.length).toBe(2);
    expect(result.groups[1].name).toBe("fail");
  });

  it("all groups pass returns passed true", () => {
    const groups: CommandGroups = {
      a: { commands: ["echo a"] },
      b: { commands: ["echo b"] },
    };
    const result = executor.runGroups(groups, ["a", "b"], process.cwd());
    expect(result.passed).toBe(true);
    expect(result.groups.length).toBe(2);
  });
});
