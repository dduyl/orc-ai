import type { AgentStrategy } from "../strategy.js";
import type { HookEvent } from "../../../core/hooks.js";

export const antigravityStrategy: AgentStrategy = {
  id: "antigravity",

  buildArgs(prompt: string): string[] {
    return ["--prompt", prompt];
  },

  keepAlive: true,

  isComplete(events: HookEvent[]): boolean {
    return events.some(e => e.type === "step_finish" && e.reason === "stop");
  },

  extractOutput(stdout: string): string {
    return stdout;
  },
};
