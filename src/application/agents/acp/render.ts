import type {
  ToolCall,
  ToolCallUpdate,
  ToolCallContent,
  ToolCallLocation,
  ContentBlock,
  ToolKind,
  ToolCallStatus,
} from "@agentclientprotocol/sdk";

/**
 * Terminal-line renderer for ACP tool-call events (ADR-026 Phase 2).
 *
 * Renders `tool_call` / `tool_call_update` payloads into plain-text terminal
 * lines fed through the existing PTY facade (`facade.feed`), so a step's
 * terminal shows the agent's tool activity — reads/edits, diffs, locations.
 * Structured GUI step-pane rendering is a later phase; this module stays the
 * shared, framework-agnostic baseline and must never throw on malformed
 * payloads.
 */

/**
 * Per-block cap for rendered content. Stays under the terminal frame batch
 * budget (`DEFAULT_MAX_FRAME_BYTES`, 4096 in frame-transport.ts) so a huge
 * diff cannot monopolize a frame; oversized blocks are truncated with a
 * marker.
 */
export const MAX_RENDER_BLOCK_CHARS = 4000;

/** Shared subset of `ToolCall` and `ToolCallUpdate` the renderer needs. */
interface RenderableToolCall {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: Array<ToolCallContent> | null;
  locations?: Array<ToolCallLocation> | null;
}

/**
 * Strip terminal-injection / control noise from agent-supplied strings before
 * they reach the xterm emulator. Newlines and tabs are preserved; ANSI escape
 * sequences and remaining C0 control characters are removed.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, "")
    .replace(/\x1b[\\PX^_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function truncateBlock(text: string): string {
  if (text.length <= MAX_RENDER_BLOCK_CHARS) return text;
  return text.slice(0, MAX_RENDER_BLOCK_CHARS) + "\n… (truncated)";
}

function renderLocations(locations: Array<ToolCallLocation>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const loc of locations) {
    if (!loc || typeof loc !== "object") continue;
    const path = sanitizeTerminalText(loc.path ?? "");
    if (!path) continue;
    const key = loc.line != null ? `${path}:${loc.line}` : path;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`    at ${key}`);
  }
  return lines;
}

function renderTextBlock(text: string, out: string[]): void {
  for (const line of truncateBlock(text).split("\n")) {
    out.push(`    ${line}`);
  }
}

function renderEmbeddedResource(resource: unknown, out: string[]): void {
  if (!resource || typeof resource !== "object") return;
  const r = resource as { text?: unknown; uri?: unknown; mimeType?: unknown };
  if (typeof r.text === "string") {
    renderTextBlock(r.text, out);
    return;
  }
  const uri = sanitizeTerminalText(typeof r.uri === "string" ? r.uri : "");
  const mime = sanitizeTerminalText(typeof r.mimeType === "string" ? r.mimeType : "");
  out.push(`    [resource: ${uri}${mime ? ` (${mime})` : ""}]`);
}

function renderContentType(content: ContentBlock | null | undefined, out: string[]): void {
  if (!content || typeof content !== "object") return;
  switch (content.type) {
    case "text":
      renderTextBlock(content.text ?? "", out);
      break;
    case "image":
      out.push(`    [image: ${sanitizeTerminalText(content.mimeType ?? "image")}]`);
      break;
    case "audio":
      out.push(`    [audio: ${sanitizeTerminalText(content.mimeType ?? "audio")}]`);
      break;
    case "resource_link":
      out.push(
        `    [resource: ${sanitizeTerminalText(content.name ?? "")}: ${sanitizeTerminalText(content.uri ?? "")}]`,
      );
      break;
    case "resource":
      renderEmbeddedResource(content.resource, out);
      break;
  }
}

function renderContentBlock(block: ToolCallContent | null | undefined, out: string[]): void {
  if (!block || typeof block !== "object") return;
  switch (block.type) {
    case "content":
      renderContentType(block.content, out);
      break;
    case "diff": {
      const path = sanitizeTerminalText(block.path ?? "?");
      const oldText = block.oldText != null ? sanitizeTerminalText(block.oldText) : undefined;
      const newText = sanitizeTerminalText(block.newText ?? "");
      const summary =
        oldText !== undefined ? ` (${oldText.split("\n").length} → ${newText.split("\n").length} lines)` : "";
      out.push(`    diff: ${path}${summary}`);
      renderTextBlock(newText, out);
      break;
    }
    case "terminal":
      out.push(`    [terminal: ${sanitizeTerminalText(block.terminalId ?? "?")}]`);
      break;
  }
}

function renderToolLines(tool: RenderableToolCall, isUpdate: boolean): string[] {
  const hasChange =
    tool.title != null ||
    tool.name != null ||
    tool.kind != null ||
    tool.status != null ||
    (tool.content != null && tool.content.length > 0) ||
    (tool.locations != null && tool.locations.length > 0);
  // A `tool_call_update` carrying nothing new (null fields mean "unchanged")
  // is a no-op for the feed.
  if (isUpdate && !hasChange) return [];

  const label = sanitizeTerminalText(tool.title ?? tool.name ?? tool.kind ?? "tool call");
  const status = tool.status != null ? ` [${tool.status}]` : "";
  const out: string[] = [`→ ${label}${status}`];

  if (tool.locations != null) out.push(...renderLocations(tool.locations));
  if (tool.content != null) {
    for (const block of tool.content) renderContentBlock(block, out);
  }
  return out;
}

/** Render a `tool_call` session update into terminal lines. */
export function renderToolCall(call: ToolCall): string[] {
  return renderToolLines(call, false);
}

/** Render a `tool_call_update` session update into terminal lines. */
export function renderToolCallUpdate(update: ToolCallUpdate): string[] {
  return renderToolLines(update, true);
}
