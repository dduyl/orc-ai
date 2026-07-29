export interface EventPartBase {
  id: string;
  messageID: string;
  sessionID: string;
}

export interface StepStartPart extends EventPartBase {
  type: "step-start";
  snapshot: string;
}

export interface TextPart extends EventPartBase {
  type: "text";
  text: string;
  time: { start: number; end: number };
}

export interface StepFinishPart extends EventPartBase {
  type: "step-finish";
  reason: string;
  snapshot: string;
  tokens: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { write: number; read: number };
  };
  cost: number;
}

export type StreamPart = StepStartPart | TextPart | StepFinishPart;

export interface StreamEventBase {
  timestamp: number;
  sessionID: string;
}

export interface StepStartEvent extends StreamEventBase {
  type: "step_start";
  part: StepStartPart;
}

export interface TextEvent extends StreamEventBase {
  type: "text";
  part: TextPart;
}

export interface StepFinishEvent extends StreamEventBase {
  type: "step_finish";
  part: StepFinishPart;
}

export type StreamEvent = StepStartEvent | TextEvent | StepFinishEvent;
