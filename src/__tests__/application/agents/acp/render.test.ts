import { describe, it, expect } from "vitest";
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import {
  renderToolCall,
  renderToolCallUpdate,
  sanitizeTerminalText,
  MAX_RENDER_BLOCK_CHARS,
} from "../../../../application/agents/acp/render.js";

describe("sanitizeTerminalText", () => {
  it("normalizes CRLF and lone CR to LF", () => {
    expect(sanitizeTerminalText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("strips ANSI CSI and OSC escape sequences", () => {
    expect(sanitizeTerminalText("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitizeTerminalText("x\x1b]0;title\x07y")).toBe("xy");
    expect(sanitizeTerminalText("\x1b[?1049hliteral")).toBe("literal");
  });

  it("strips C0 control characters but preserves tabs and newlines", () => {
    expect(sanitizeTerminalText("a\x00b\x07c\x1f")).toBe("abc");
    expect(sanitizeTerminalText("a\tb\nc")).toBe("a\tb\nc");
  });
});

describe("renderToolCall", () => {
  it("renders a header with title and status", () => {
    const lines = renderToolCall({
      toolCallId: "tc-1",
      title: "Reading src/foo.ts",
      name: "read_file",
      kind: "read",
      status: "in_progress",
    });
    expect(lines).toEqual(["→ Reading src/foo.ts [in_progress]"]);
  });

  it("prefers title over name, then kind, then a fallback", () => {
    expect(
      renderToolCall({
        toolCallId: "tc-1",
        title: "The Title",
        name: "read_file",
        kind: "read",
      }),
    ).toEqual(["→ The Title"]);
    expect(
      renderToolCall({
        toolCallId: "tc-1",
        name: "write_file",
        kind: "edit",
      } as ToolCall),
    ).toEqual(["→ write_file"]);
    expect(renderToolCall({ toolCallId: "tc-1", kind: "search" } as ToolCall)).toEqual(["→ search"]);
    expect(renderToolCall({ toolCallId: "tc-1" } as ToolCall)).toEqual(["→ tool call"]);
  });

  it("renders deduplicated locations with path and path:line", () => {
    const lines = renderToolCall({
      toolCallId: "tc-1",
      title: "Editing src/foo.ts",
      locations: [
        { path: "src/foo.ts", line: 42 },
        { path: "src/foo.ts", line: 42 },
        { path: "src/bar.ts" },
      ],
    });
    expect(lines).toEqual(["→ Editing src/foo.ts", "    at src/foo.ts:42", "    at src/bar.ts"]);
  });

  it("renders text content blocks indented", () => {
    const lines = renderToolCall({
      toolCallId: "tc-1",
      title: "Read src/foo.ts",
      content: [{ type: "content", content: { type: "text", text: "line1\nline2" } }],
    });
    expect(lines).toEqual(["→ Read src/foo.ts", "    line1", "    line2"]);
  });

  it("renders diff content with a hunk summary and the new text", () => {
    const lines = renderToolCall({
      toolCallId: "tc-1",
      title: "Edit src/foo.ts",
      content: [{ type: "diff", path: "src/foo.ts", oldText: "a\nb", newText: "a\nb\nc" }],
    });
    expect(lines).toEqual(["→ Edit src/foo.ts", "    diff: src/foo.ts (2 → 3 lines)", "    a", "    b", "    c"]);
  });

  it("renders diff content without oldText as a plain block", () => {
    const lines = renderToolCall({
      toolCallId: "tc-1",
      title: "Create src/foo.ts",
      content: [{ type: "diff", path: "src/foo.ts", newText: "x\ny" }],
    });
    expect(lines).toEqual(["→ Create src/foo.ts", "    diff: src/foo.ts", "    x", "    y"]);
  });

  it("renders media and resource blocks as compact placeholders", () => {
    const lines = renderToolCall({
      toolCallId: "tc-1",
      title: "Screenshot",
      content: [
        { type: "content", content: { type: "image", data: "abc", mimeType: "image/png" } },
        { type: "content", content: { type: "audio", data: "abc", mimeType: "audio/wav" } },
        {
          type: "content",
          content: { type: "resource_link", name: "docs", uri: "file:///doc.md" },
        },
        { type: "terminal", terminalId: "term-1" },
      ],
    });
    expect(lines).toEqual([
      "→ Screenshot",
      "    [image: image/png]",
      "    [audio: audio/wav]",
      "    [resource: docs: file:///doc.md]",
      "    [terminal: term-1]",
    ]);
  });

  it("renders an embedded text resource inline and a binary one as a placeholder", () => {
    const lines = renderToolCall({
      toolCallId: "tc-1",
      title: "Read asset",
      content: [
        { type: "content", content: { type: "resource", resource: { text: "payload", uri: "file:///asset.txt" } } },
        { type: "content", content: { type: "resource", resource: { blob: "AA==", uri: "x://y", mimeType: "application/octet-stream" } } },
      ],
    });
    expect(lines).toEqual([
      "→ Read asset",
      "    payload",
      "    [resource: x://y (application/octet-stream)]",
    ]);
  });

  it("truncates oversized text blocks to MAX_RENDER_BLOCK_CHARS", () => {
    const big = "x".repeat(MAX_RENDER_BLOCK_CHARS + 50);
    const lines = renderToolCall({
      toolCallId: "tc-1",
      title: "Huge",
      content: [{ type: "content", content: { type: "text", text: big } }],
    });
    expect(lines.length).toBe(3);
    expect(lines[1]).toHaveLength(MAX_RENDER_BLOCK_CHARS + 4);
    expect(lines[2]).toMatch(/^    … \(truncated\)$/);
  });

  it("never throws on a malformed content block", () => {
    expect(() =>
      renderToolCall({
        toolCallId: "tc-1",
        title: "Broken",
        content: [null as unknown as ToolCall["content"] extends Array<infer T> ? T : never],
      }),
    ).not.toThrow();
  });
});

describe("renderToolCallUpdate", () => {
  it("returns no lines when the update changed nothing visible", () => {
    expect(renderToolCallUpdate({ toolCallId: "tc-1", rawInput: { path: "src/x.ts" } })).toEqual([]);
  });

  it("renders a status-only update", () => {
    expect(renderToolCallUpdate({ toolCallId: "tc-1", status: "completed" })).toEqual(["→ tool call [completed]"]);
  });

  it("renders content replacements in updates", () => {
    const lines = renderToolCallUpdate({
      toolCallId: "tc-1",
      content: [{ type: "diff", path: "src/foo.ts", newText: "z" }],
    });
    expect(lines).toEqual(["→ tool call", "    diff: src/foo.ts", "    z"]);
  });
});
