import { EventEmitter } from "node:events";
import type { StreamEvent } from "./types.js";
import type { QuotaInfo } from "../../application/agents/errors.js";

let seqCounter = 0;

type StreamEventHandler = (event: StreamEvent) => void;
let _globalHandler: StreamEventHandler | null = null;

export function setStreamEventHandler(handler: StreamEventHandler | null) {
  _globalHandler = handler;
}

export class StreamEmitter extends EventEmitter {
  private sessionID: string;
  private messageID: string;
  private stepStartTimes = new Map<string, number>();

  constructor(sessionID?: string) {
    super();
    this.sessionID = sessionID || `ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.messageID = `msg_${this.sessionID}`;
  }

  private uid(): string {
    seqCounter++;
    return `prt_${Date.now().toString(36)}${seqCounter.toString(36).padStart(4, "0")}`;
  }

  private write(event: StreamEvent): void {
    if (this.listenerCount("event") > 0) {
      this.emit("event", event);
    } else if (_globalHandler) {
      _globalHandler(event);
    } else {
      process.stdout.write(JSON.stringify(event) + "\n");
    }
  }

  stepStart(stepId: string, snapshot?: string): void {
    this.stepStartTimes.set(stepId, Date.now());
    this.write({
      type: "step_start",
      timestamp: Date.now(),
      sessionID: this.sessionID,
      part: {
        id: this.uid(),
        messageID: this.messageID,
        sessionID: this.sessionID,
        snapshot: snapshot || "",
        type: "step-start",
      },
    });
  }

  text(stepId: string, text: string): void {
    const start = this.stepStartTimes.get(stepId) || Date.now();
    this.write({
      type: "text",
      timestamp: Date.now(),
      sessionID: this.sessionID,
      part: {
        id: this.uid(),
        messageID: this.messageID,
        sessionID: this.sessionID,
        type: "text",
        text,
        time: { start, end: Date.now() },
      },
    });
  }

  stepFinish(
    stepId: string,
    reason: string,
    snapshot: string,
    tokens: { total: number; input: number; output: number; reasoning: number; cache: { write: number; read: number } },
    cost: number,
    quota?: QuotaInfo,
  ): void {
    this.write({
      type: "step_finish",
      timestamp: Date.now(),
      sessionID: this.sessionID,
      part: {
        id: this.uid(),
        messageID: this.messageID,
        sessionID: this.sessionID,
        type: "step-finish",
        reason,
        snapshot,
        tokens,
        cost,
        ...(quota ? { quota } : {}),
      },
    });
    this.stepStartTimes.delete(stepId);
  }
}
