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
  /**
   * A prompt turn ended (`stop` message). `stopReason: "error"` is a
   * client-side sentinel emitted after `error` frames so the turn sequence
   * still closes (divider + counter) on the error path.
   */
  | { kind: "turn"; stopReason: AcpStopReason | "error" }
  /** The session failed; the stream will EOF. */
  | { kind: "error"; message: string }
  /** Slash commands the agent can run (`available_commands_update`). */
  | { kind: "commands"; commands: AgentCommand[] }
  /** Session configuration options and their current state (`session/new` / `config_option_update`). */
  | { kind: "config"; options: AgentConfigOption[] };

/** A slash command the agent advertises via `available_commands_update`. */
export interface AgentCommand {
  name: string;
  description: string;
  /** Input hint when the command requires an argument (e.g. `/help <topic>`). */
  input?: string;
}

/**
 * One session configuration option (model / mode / thought-level selector).
 * Normalized from the ACP `SessionConfigOption` union so the renderer can
 * render a selector without depending on the ACP SDK types.
 */
export interface AgentConfigOption {
  /** The option's stable id (`configId`), used when setting a value. */
  id: string;
  /** Human-readable label, e.g. "Model". */
  name: string;
  /** Semantic category (`"model"`, `"mode"`, `"thought_level"`, …) when present. */
  category?: string | null;
  type: "select" | "boolean";
  /** The currently selected value (value id for select, boolean for boolean). */
  currentValue: string | boolean | null;
  /** Selectable values for `select` options (groups flattened). */
  options?: Array<{ value: string; name: string }>;
}

/** Serialize a main frame to the payload carried by a `__main__` frame. */
export function encodeMainFrame(frame: MainFrame): Buffer {
  return Buffer.from(JSON.stringify(frame), "utf8");
}

/** Every {@link MainFrame} discriminator accepted by the wire codec. */
const MAIN_FRAME_KINDS = new Set(["text", "tool", "tool_update", "usage", "turn", "error", "commands", "config"]);

/** Parse a `__main__` frame payload back into a {@link MainFrame}. */
export function decodeMainFrame(payload: Buffer): MainFrame {
  const parsed: unknown = JSON.parse(payload.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { kind?: unknown }).kind !== "string") {
    throw new Error("Not a main frame payload");
  }
  // Strict discriminator: an unknown `kind` is a version-skew / wire-corruption
  // signal, not a frame we can render. Reject it so callers drop (and log) it
  // instead of mis-rendering stale or forward-compatible payloads.
  const kind = (parsed as { kind: string }).kind;
  if (!MAIN_FRAME_KINDS.has(kind)) {
    throw new Error(`Unknown main frame kind: ${kind}`);
  }
  return parsed as MainFrame;
}
