import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AgentUsage, AcpStopReason } from "../../agents/acp/types.js";

/**
 * Structured frame envelope for the daemon-owned main terminal (ADR-026).
 *
 * In PTY mode the main pipe carries raw bytes; when the main session runs over
 * ACP (a persistent agent child instead of the interactive TUI), the same pipe
 * carries length-prefixed frames whose payload is this JSON envelope — one
 * `MainFrame` per ACP event. A client demuxes by `kind` to render a chat
 * without re-parsing ANSI. The step id remains `__main__`, so the wire framing
 * (`frame-transport.ts`) and `attachMain`/`attachMainStream` flows are shared.
 *
 * Permission requests deliberately do NOT flow over this pipe: they are an
 * interactive, answered protocol — they travel over the control pipe as a
 * `permissionRequested` notification + `answerPermission` request.
 */
export type MainFrame =
  /** A streamed agent text chunk (`agent_message_chunk`). */
  | { kind: "text"; text: string }
  /** A tool call started (`tool_call`). */
  | { kind: "tool"; call: ToolCall }
  /** A tool call progressed (`tool_call_update`). */
  | { kind: "tool_update"; update: ToolCallUpdate }
  /** Token usage so far (`usage_update` / the turn's stop usage). */
  | { kind: "usage"; usage: AgentUsage }
  /** A prompt turn ended (`stop` message). */
  | { kind: "turn"; stopReason: AcpStopReason }
  /** The session failed; the stream will EOF. */
  | { kind: "error"; message: string };

/** Serialize a main frame to the payload carried by a `__main__` frame. */
export function encodeMainFrame(frame: MainFrame): Buffer {
  return Buffer.from(JSON.stringify(frame), "utf8");
}

/** Parse a `__main__` frame payload back into a {@link MainFrame}. */
export function decodeMainFrame(payload: Buffer): MainFrame {
  const parsed: unknown = JSON.parse(payload.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { kind?: unknown }).kind !== "string") {
    throw new Error("Not a main frame payload");
  }
  return parsed as MainFrame;
}
