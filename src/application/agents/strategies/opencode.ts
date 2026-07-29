import type { AgentStrategy } from "../strategy.js";
import type { HookEvent } from "../../../core/hooks.js";

export const opencodeStrategy: AgentStrategy = {
  id: "opencode",

  buildArgs(prompt: string): string[] {
    return ["--pure", "--prompt", prompt];
  },

  keepAlive: true,

  isComplete(events: HookEvent[]): boolean {
    return events.some(e => e.type === "step_finish" && e.reason === "stop");
  },

  extractOutput(stdout: string): string {
    return stdout;
  },
};
