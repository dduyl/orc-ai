export const GATE_OUTPUT_ENABLED = (() => {
  if (typeof process === "undefined" || !process.env) return true;
  const v = process.env.ORC_GATE_OUTPUT_ENABLED;
  if (v === undefined) return true;
  return v !== "0" && v.toLowerCase() !== "false";
})();
export const GATE_OUTPUT_THRESHOLD_CHARS = 1024;
export const GATE_OUTPUT_HEAD_LINES = 30;
export const GATE_OUTPUT_TAIL_LINES = 30;
export const GATE_OUTPUT_MAX_CHARS = 64 * 1024;
export const GATE_OUTPUT_MAX_ERROR_LINES = 50;

const ANSI_RE = /\u001b\[[0-9;?]*[a-zA-Z]/g;
const OSC_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ERROR_LINE_RE = /\b(?:error|fatal|panic|exception|traceback|assert|fail(?:ed|ure|ing)?)\b/i;

export interface CompressedGateOutput {
  stdout: string;
  stderr: string;
  changed: boolean;
  originalChars: number;
  compressedChars: number;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Strip ANSI CSI/OSC escapes and stray `\r` (CRLF -> LF) from a stream. */
function stripEscapes(text: string): string {
  return text.replace(ANSI_RE, "").replace(OSC_RE, "").replace(/\r/g, "");
}

/** Collapse blank runs to a single blank and identical consecutive lines to `line [xN]`. */
function collapseLines(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      out.push("");
      while (i < lines.length && lines[i].trim() === "") i++;
      continue;
    }
    let run = 1;
    while (i + run < lines.length && lines[i + run] === line) run++;
    out.push(run > 1 ? `${line} [x${run}]` : line);
    i += run;
  }
  return out;
}

/**
 * Window lines to head/tail with an omitted-count marker. Error-signal lines
 * from the omitted middle survive so the repair agent still sees what broke
 * even when the failure is mid-log. The cap keeps the LAST error lines
 * (failures cluster toward the end) and lines already present in head/tail
 * are not duplicated.
 */
function windowLines(lines: string[]): string[] {
  const total = lines.length;
  if (total <= GATE_OUTPUT_HEAD_LINES + GATE_OUTPUT_TAIL_LINES) return lines;
  const head = lines.slice(0, GATE_OUTPUT_HEAD_LINES);
  const tail = lines.slice(total - GATE_OUTPUT_TAIL_LINES);
  const middle = lines.slice(GATE_OUTPUT_HEAD_LINES, total - GATE_OUTPUT_TAIL_LINES);
  // A single-line middle is replaced by a marker that is longer than the line;
  // windowing would grow (not shrink) the output, so keep it untouched.
  if (middle.length <= 1) return lines;
  const headTail = new Set([...head, ...tail]);
  const errors: string[] = [];
  let errorCount = 0;
  for (const line of middle) {
    if (headTail.has(line)) continue;
    if (!ERROR_LINE_RE.test(line)) continue;
    errorCount++;
    if (errors.length === GATE_OUTPUT_MAX_ERROR_LINES) errors.shift();
    errors.push(line);
  }
  const out = [...head, `[${plural(middle.length, "line")} omitted]`];
  if (errorCount > 0) {
    if (errorCount > GATE_OUTPUT_MAX_ERROR_LINES) {
      out.push(`[${plural(errorCount - GATE_OUTPUT_MAX_ERROR_LINES, "error line")} omitted]`);
    }
    out.push(...errors);
  }
  out.push(...tail);
  return out;
}

/**
 * Hard-cap a stream at GATE_OUTPUT_MAX_CHARS. Slicing is code-point safe
 * (never splits a surrogate pair). Error-signal lines dropped by the cut are
 * preserved (last-N, capped) so truncation does not silently discard the
 * very failures the compression exists to surface.
 */
function truncate(text: string): string {
  if (text.length <= GATE_OUTPUT_MAX_CHARS) return text;
  let cut = GATE_OUTPUT_MAX_CHARS;
  const low = text.charCodeAt(cut);
  if (low >= 0xdc00 && low <= 0xdfff) cut -= 1;
  const kept = text.slice(0, cut);
  const dropped = text.slice(cut);
  const droppedErrors: string[] = [];
  let errorCount = 0;
  for (const line of dropped.split("\n")) {
    if (!ERROR_LINE_RE.test(line)) continue;
    errorCount++;
    if (droppedErrors.length === GATE_OUTPUT_MAX_ERROR_LINES) droppedErrors.shift();
    droppedErrors.push(line);
  }
  const out = [kept, "[truncated]"];
  if (errorCount > 0) {
    if (errorCount > GATE_OUTPUT_MAX_ERROR_LINES) {
      out.push(`[${plural(errorCount - GATE_OUTPUT_MAX_ERROR_LINES, "error line")} omitted]`);
    }
    out.push(...droppedErrors);
  }
  return out.join("\n");
}

function compressStream(text: string): string {
  // Fast path: a single line under the cap with no escapes cannot be
  // compressed further (collapse/window operate per line).
  if (text.length <= GATE_OUTPUT_MAX_CHARS && !text.includes("\n") && !text.includes("\u001b")) return text;
  const stripped = stripEscapes(text);
  const collapsed = collapseLines(stripped.split("\n"));
  const windowed = windowLines(collapsed);
  return truncate(windowed.join("\n"));
}

/**
 * Compress a single command group's captured stdout/stderr for embedding into
 * a repair prompt. Outputs under the threshold (combined across both streams,
 * since the goal is total prompt size) are returned untouched — no churn on
 * small/passing gates. `changed` reports whether either stream was modified;
 * sizes let the caller annotate the prompt with the compression ratio.
 */
export function compressGateOutput(stdout: string | undefined, stderr: string | undefined): CompressedGateOutput {
  const sOut = stdout ?? "";
  const sErr = stderr ?? "";
  const originalChars = sOut.length + sErr.length;
  if (!GATE_OUTPUT_ENABLED || originalChars < GATE_OUTPUT_THRESHOLD_CHARS) {
    return { stdout: sOut, stderr: sErr, changed: false, originalChars, compressedChars: originalChars };
  }
  const cStdout = sOut ? compressStream(sOut) : "";
  const cStderr = sErr ? compressStream(sErr) : "";
  const compressedChars = cStdout.length + cStderr.length;
  const changed = cStdout !== sOut || cStderr !== sErr;
  return { stdout: cStdout, stderr: cStderr, changed, originalChars, compressedChars };
}