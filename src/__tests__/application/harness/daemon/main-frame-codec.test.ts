import { describe, it, expect } from "vitest";
import { decodeMainFrame, encodeMainFrame, type MainFrame } from "../../../../application/harness/daemon/main-frame-codec.js";
import { renderMainFrame } from "../../../../delivery/gui/daemon-bridge.js";

describe("main frame codec", () => {
  it("round-trips every frame kind", () => {
    const frames: MainFrame[] = [
      { kind: "text", text: "hello world" },
      { kind: "tool", call: { toolCallId: "tc-1", title: "Write file", name: "write_file", status: "in_progress" } as never },
      { kind: "tool_update", update: { toolCallId: "tc-1", name: "write_file", status: "completed" } as never },
      { kind: "usage", usage: { totalTokens: 12, inputTokens: 5, outputTokens: 7 } },
      { kind: "turn", stopReason: "end_turn" },
      { kind: "turn", stopReason: "error" },
      { kind: "error", message: "boom" },
    ];
    for (const frame of frames) {
      expect(decodeMainFrame(encodeMainFrame(frame))).toEqual(frame);
    }
  });

  it("rejects payloads that are not main frames", () => {
    expect(() => decodeMainFrame(Buffer.from("not json", "utf8"))).toThrow();
    expect(() => decodeMainFrame(Buffer.from(JSON.stringify({ hello: 1 }), "utf8"))).toThrow();
  });

  it("rejects unknown main-frame kinds (strict discriminator)", () => {
    expect(() => decodeMainFrame(Buffer.from(JSON.stringify({ kind: "bogus" }), "utf8"))).toThrow(
      /Unknown main frame kind: bogus/,
    );
  });
});

describe("renderMainFrame", () => {
  it("streams text chunks as-is", () => {
    expect(renderMainFrame({ kind: "text", text: "hi" })).toBe("hi");
  });

  it("labels tool calls and updates", () => {
    expect(
      renderMainFrame({ kind: "tool", call: { toolCallId: "tc-1", title: "Write file" } as never }),
    ).toContain("[tool] Write file");
    expect(
      renderMainFrame({ kind: "tool_update", update: { toolCallId: "tc-1", name: "bash" } as never }),
    ).toContain("[tool update] bash");
  });

  it("renders usage and turn/error markers", () => {
    expect(renderMainFrame({ kind: "usage", usage: { totalTokens: 10, inputTokens: 4, outputTokens: 6 } })).toContain("10");
    expect(renderMainFrame({ kind: "turn", stopReason: "end_turn" })).toContain("[turn end: end_turn]");
    expect(renderMainFrame({ kind: "error", message: "boom" })).toContain("[error] boom");
  });
});
