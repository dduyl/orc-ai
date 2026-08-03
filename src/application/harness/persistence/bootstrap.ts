import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECT_DIRS = [
  "requirements",
  "architecture",
  "tests",
  "code",
  "review",
  "index",
];

const DEFAULT_COMMANDS_TOML = `# Project-local validation gates (ADR-006).
# Owned and updated by the Architecture Agent at init and on structural change.
# Values are literal shell commands; a workflow \`type: script\` step resolves a
# key here or declares an inline command.
[validate]
commands = ["echo 'no validate command configured'"]

[test.unit]
commands = ["echo 'no unit test command configured'"]

[test.integration]
commands = ["echo 'no integration test command configured'"]
`;

export function commandsTomlPath(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  return join(root, "commands.toml");
}

export function setupProject(projectRoot?: string): void {
  const root = projectRoot || process.cwd();
  const agentsDir = join(root, ".agents");
  for (const sub of PROJECT_DIRS) {
    mkdirSync(join(agentsDir, sub), { recursive: true });
  }
  const commandsPath = commandsTomlPath(root);
  if (!existsSync(commandsPath)) {
    writeFileSync(commandsPath, DEFAULT_COMMANDS_TOML, "utf-8");
  }
}

export function setupInfrastructure(): void {
  const configDir = join(homedir(), ".orc");
  mkdirSync(join(configDir, "workflows"), { recursive: true });
}

export function bootstrap(projectRoot?: string): void {
  setupInfrastructure();
  setupProject(projectRoot);
}
