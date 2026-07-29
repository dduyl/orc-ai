import type { AgentStrategy } from "../strategy.js";
import type { HookEvent } from "../../hooks/types.js";

export const claudeStrategy: AgentStrategy = {
  id: "claude",

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
