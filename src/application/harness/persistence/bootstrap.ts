import { mkdirSync } from "node:fs";
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

export function setupProject(projectRoot?: string): void {
  const root = projectRoot || process.cwd();
  const agentsDir = join(root, ".agents");
  for (const sub of PROJECT_DIRS) {
    mkdirSync(join(agentsDir, sub), { recursive: true });
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
