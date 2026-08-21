import type { AgentStrategy } from "../strategy.js";
import type { HookEvent } from "../../../core/hooks.js";

export const claudeStrategy: AgentStrategy = {
  id: "claude",

  buildArgs(prompt: string, model?: string): string[] {
    return ["--prompt", prompt, ...(model ? ["--model", model] : [])];
  },

  supportsModel: true,

  keepAlive: true,

  isComplete(events: HookEvent[]): boolean {
    return events.some(e => e.type === "step_finish" && e.reason === "stop");
  },

  extractOutput(stdout: string): string {
    return stdout;
  },
};
