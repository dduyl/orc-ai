let _agentCwd: string | undefined;

export function setAgentCwd(dir: string): void {
  _agentCwd = dir;
}

export function getAgentCwd(): string {
  return _agentCwd ?? process.cwd();
}
