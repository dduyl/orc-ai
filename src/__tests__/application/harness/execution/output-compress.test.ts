import { describe, it, expect } from "vitest";
import {
  compressGateOutput,
  GATE_OUTPUT_THRESHOLD_CHARS,
  GATE_OUTPUT_HEAD_LINES,
  GATE_OUTPUT_TAIL_LINES,
  GATE_OUTPUT_MAX_CHARS,
  GATE_OUTPUT_MAX_ERROR_LINES,
} from "../../../../application/harness/execution/output-compress.js";

describe("compressGateOutput", () => {
  it("passes small output through untouched with changed=false", () => {
    const out = compressGateOutput("line1\nline2", "note");
    expect(out).toEqual({
      stdout: "line1\nline2",
      stderr: "note",
      changed: false,
      originalChars: 15,
      compressedChars: 15,
    });
  });

  it("passes through empty streams unchanged", () => {
    const out = compressGateOutput("", "");
    expect(out).toEqual({ stdout: "", stderr: "", changed: false, originalChars: 0, compressedChars: 0 });
  });

  it("strips ANSI escapes from a large stream", () => {
    const ansi = "\u001b[31mFAIL\u001b[0m line\n".repeat(60);
    const out = compressGateOutput(ansi, "");
    expect(out.stdout).not.toContain("\u001b[");
    expect(out.stdout).toContain("FAIL line");
    expect(out.changed).toBe(true);
  });

  it("collapses blank runs to a single blank line", () => {
    const raw = "a\n\n\n\nb\n\n\nc\n".repeat(120);
    const out = compressGateOutput(raw, "");
    expect(out.stdout).toContain("a\n\nb\n\nc");
    expect(out.stdout).not.toContain("\n\n\n");
  });

  it("collapses identical consecutive lines into a [xN] marker", () => {
    const raw = "same line\nsame line\nsame line\nend\n".repeat(60);
    const out = compressGateOutput(raw, "");
    expect(out.stdout).toContain("same line [x3]");
    expect(out.stdout).toContain("end");
  });

  it("windows a large stream to head + omitted marker + tail", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const out = compressGateOutput(lines.join("\n"), "");
    const got = out.stdout.split("\n");
    expect(got[0]).toBe("line 0");
    expect(got[GATE_OUTPUT_HEAD_LINES]).toBe(`[${500 - GATE_OUTPUT_HEAD_LINES - GATE_OUTPUT_TAIL_LINES} lines omitted]`);
    expect(got[got.length - 1]).toBe("line 499");
    expect(got.length).toBe(GATE_OUTPUT_HEAD_LINES + GATE_OUTPUT_TAIL_LINES + 1);
    expect(out.stdout).toContain("line 0");
    expect(out.stdout).toContain("line 499");
    expect(out.stdout).not.toContain("line 250");
  });

  it("preserves error-signal lines from the omitted middle", () => {
    const lines = Array.from({ length: 500 }, (_, i) => (i === 250 ? "ERROR: boom" : i === 260 ? "FAILED: tests" : `line ${i}`));
    const out = compressGateOutput(lines.join("\n"), "");
    expect(out.stdout).toContain("ERROR: boom");
    expect(out.stdout).toContain("FAILED: tests");
    expect(out.stdout).toContain("lines omitted]");
  });

  it("keeps error lines even when they fall outside the head/tail window", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    lines[100] = "Traceback (most recent call last)";
    const out = compressGateOutput(lines.join("\n"), "");
    expect(out.stdout).toContain("Traceback (most recent call last)");
  });

  it("caps preserved error lines at the configured maximum", () => {
    const lines = Array.from({ length: 500 }, (_, i) => (i >= 40 && i < 40 + 80 ? `ERROR ${i}` : `line ${i}`));
    const out = compressGateOutput(lines.join("\n"), "");
    const errorMarks = out.stdout.match(/ERROR \d+/g) ?? [];
    expect(errorMarks.length).toBe(GATE_OUTPUT_MAX_ERROR_LINES);
    expect(out.stdout).toContain(`${80 - GATE_OUTPUT_MAX_ERROR_LINES} error lines omitted`);
  });

  it("hard-caps output at GATE_OUTPUT_MAX_CHARS with a truncated marker", () => {
    const huge = "x".repeat(GATE_OUTPUT_MAX_CHARS * 2);
    const out = compressGateOutput(huge, "");
    expect(out.stdout.length).toBeLessThanOrEqual(GATE_OUTPUT_MAX_CHARS + "[truncated]".length + 1);
    expect(out.stdout.endsWith("[truncated]")).toBe(true);
  });

  it("compresses stdout and stderr independently", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const out = compressGateOutput(big, "small err");
    expect(out.stdout).toContain("lines omitted]");
    expect(out.stderr).toBe("small err");
    expect(out.changed).toBe(true);
  });

  it("compresses only when total chars meet the threshold", () => {
    const near = "same\n".repeat(Math.floor(GATE_OUTPUT_THRESHOLD_CHARS / 5));
    expect(compressGateOutput(near, "").changed).toBe(false);
    const over = "same\n".repeat(Math.floor(GATE_OUTPUT_THRESHOLD_CHARS / 5) * 4);
    expect(compressGateOutput(over, "").changed).toBe(true);
  });

  it("reports original and compressed char counts", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const out = compressGateOutput(big, "");
    expect(out.originalChars).toBe(big.length);
    expect(out.compressedChars).toBe(out.stdout.length);
    expect(out.compressedChars).toBeLessThan(out.originalChars);
  });

  it("handles undefined streams defensively", () => {
    const out = compressGateOutput(undefined, undefined);
    expect(out).toEqual({ stdout: "", stderr: "", changed: false, originalChars: 0, compressedChars: 0 });
  });

  it("round-trips a trailing newline unchanged below threshold", () => {
    const out = compressGateOutput("a\nb\n", "note\n");
    expect(out.stdout).toBe("a\nb\n");
    expect(out.stderr).toBe("note\n");
    expect(out.changed).toBe(false);
  });

  it("normalizes CRLF line endings without leaving stray carriage returns", () => {
    const raw = "a\r\nb\r\nc\r\n".repeat(400);
    const out = compressGateOutput(raw, "");
    expect(out.stdout).not.toContain("\r");
    expect(out.stdout).toContain("a\nb\nc");
  });

  it("compresses all-blank output to empty and reports changed", () => {
    const raw = "\n\n\n\n".repeat(300);
    const out = compressGateOutput(raw, "");
    expect(out.stdout).toBe("");
    expect(out.changed).toBe(true);
  });

  it("preserves an error at the end of a single oversized line through truncation", () => {
    const raw = "x".repeat(GATE_OUTPUT_MAX_CHARS) + "ERROR: boom";
    const out = compressGateOutput(raw, "");
    expect(out.stdout.length).toBeLessThanOrEqual(GATE_OUTPUT_MAX_CHARS + "[truncated]".length + 1 + GATE_OUTPUT_MAX_ERROR_LINES);
    expect(out.stdout).toContain("ERROR: boom");
    expect(out.stdout).toContain("[truncated]");
  });

  it("strips cursor-hide and OSC sequences, not just CSI color codes", () => {
    const raw = "\u001b[?25l\u001b]0;title\u0007FAIL line\n".repeat(60);
    const out = compressGateOutput(raw, "");
    expect(out.stdout).not.toContain("\u001b[");
    expect(out.stdout).not.toContain("\u0007");
    expect(out.stdout).toContain("FAIL line");
  });

  it("keeps a collapsed repeated error line", () => {
    const lines = Array.from({ length: 400 }, (_, i) => (i >= 100 && i <= 102 ? "ERROR: repeat" : `line ${i}`));
    const out = compressGateOutput(lines.join("\n"), "");
    expect(out.stdout).toContain("ERROR: repeat [x3]");
  });

  it("keeps the LAST capped error lines so late failures survive crowding", () => {
    const lines = Array.from({ length: 500 }, (_, i) => {
      if (i >= 40 && i < 40 + 60) return "ERROR noise " + i;
      if (i === 400) return "FATAL: real failure at end";
      return `line ${i}`;
    });
    const out = compressGateOutput(lines.join("\n"), "");
    expect(out.stdout).toContain("FATAL: real failure at end");
    expect((out.stdout.match(/ERROR noise \d+/g) ?? []).length).toBeLessThanOrEqual(GATE_OUTPUT_MAX_ERROR_LINES);
  });

  it("respects the exact threshold boundary (1023 passes, 1024 compresses)", () => {
    const under = "a\n".repeat(Math.floor(GATE_OUTPUT_THRESHOLD_CHARS / 2) - 1) + "a";
    const at = "a\n".repeat(GATE_OUTPUT_THRESHOLD_CHARS / 2);
    expect(compressGateOutput(under, "").changed).toBe(false);
    expect(compressGateOutput(at, "").changed).toBe(true);
  });

  it("leaves a 61-line window (single middle line) unchanged instead of growing output", () => {
    const lines = Array.from({ length: GATE_OUTPUT_HEAD_LINES + GATE_OUTPUT_TAIL_LINES + 1 }, (_, i) => `line ${i} ` + "z".repeat(20));
    const out = compressGateOutput(lines.join("\n"), "");
    expect(out.stdout).toBe(lines.join("\n"));
    expect(out.changed).toBe(false);
  });

  it("passes a single long line under the cap through unchanged", () => {
    const raw = "x".repeat(2000);
    expect(compressGateOutput(raw, "").changed).toBe(false);
  });

  it("keeps error lines when the windowed output still exceeds the cap", () => {
    const longLine = (label: string) => label + " " + "y".repeat(2500);
    const head = Array.from({ length: GATE_OUTPUT_HEAD_LINES }, (_, i) => longLine(`head ${i}`));
    const middle = Array.from({ length: 100 }, (_, i) => (i === 50 ? "ERROR: hidden mid-log failure" : `m ${i}`));
    const tail = Array.from({ length: GATE_OUTPUT_TAIL_LINES }, (_, i) => longLine(`tail ${i}`));
    const out = compressGateOutput([...head, ...middle, ...tail].join("\n"), "");
    expect(out.stdout).toContain("ERROR: hidden mid-log failure");
    expect(out.stdout).toContain("[truncated]");
  });

  it("does not split a surrogate pair at the truncation boundary", () => {
    const emoji = "a".repeat(GATE_OUTPUT_MAX_CHARS - 1) + "😀" + "z".repeat(10);
    const out = compressGateOutput(emoji, "");
    expect(out.stdout).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.stdout).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
