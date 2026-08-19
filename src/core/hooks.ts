export type HookEventType = "tool_call" | "tool_result" | "step_finish";

export interface ToolCallEvent {
  type: "tool_call";
  timestamp: number;
  stepId: string;
  tool: string;
  input: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  timestamp: number;
  stepId: string;
  tool: string;
  output?: string;
  error?: string;
  files?: string[];
}

export interface StepQuotaInfo {
  kind: "quota";
  resetAtMs?: number;
  message: string;
}

export interface StepFinishEvent {
  type: "step_finish";
  timestamp: number;
  stepId: string;
  reason: string;
  tokens?: {
    total: number;
    input: number;
    output: number;
  };
  quota?: StepQuotaInfo;
}

export type HookEvent = ToolCallEvent | ToolResultEvent | StepFinishEvent;

export const HOOK_FILE_ENV = "ORC_STATUS_FILE";
