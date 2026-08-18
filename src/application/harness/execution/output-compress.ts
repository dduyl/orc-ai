export const GATE_OUTPUT_ENABLED = true;
export const GATE_OUTPUT_THRESHOLD_CHARS = 1024;
export const GATE_OUTPUT_HEAD_LINES = 30;
export const GATE_OUTPUT_TAIL_LINES = 30;
export const GATE_OUTPUT_MAX_CHARS = 64 * 1024;
export const GATE_OUTPUT_MAX_ERROR_LINES = 50;

const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;
const ERROR_LINE_RE = /error|fatal|panic|exception|traceback|assert|fail(?:ed|ure|ing)?/i;

export interface CompressedGateOutput {
  stdout: string;
  stderr: string;
  changed: boolean;
  originalChars: number;
  compressedChars: number;
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
 * from the omitted middle survive (capped) so the repair agent still sees
 * what broke even when the failure is mid-log.
 */
function windowLines(lines: string[]): string[] {
  if (lines.length <= GATE_OUTPUT_HEAD_LINES + GATE_OUTPUT_TAIL_LINES) return lines;
  const head = lines.slice(0, GATE_OUTPUT_HEAD_LINES);
  const tail = lines.slice(lines.length - GATE_OUTPUT_TAIL_LINES);
  const middle = lines.slice(GATE_OUTPUT_HEAD_LINES, lines.length - GATE_OUTPUT_TAIL_LINES);
  const errors = middle.filter(l => ERROR_LINE_RE.test(l));
  const out = [...head, `[${middle.length} lines omitted]`];
  if (errors.length > 0) {
    if (errors.length > GATE_OUTPUT_MAX_ERROR_LINES) {
      out.push(`[${errors.length - GATE_OUTPUT_MAX_ERROR_LINES} error lines omitted]`);
      out.push(...errors.slice(0, GATE_OUTPUT_MAX_ERROR_LINES));
    } else {
      out.push(...errors);
    }
  }
  out.push(...tail);
  return out;
}

function compressStream(text: string): string {
  const stripped = text.replace(ANSI_RE, "");
  const collapsed = collapseLines(stripped.split("\n"));
  const windowed = windowLines(collapsed);
  let out = windowed.join("\n");
  if (out.length > GATE_OUTPUT_MAX_CHARS) {
    out = out.slice(0, GATE_OUTPUT_MAX_CHARS) + "\n[truncated]";
  }
  return out;
}

/**
 * Compress a single command group's captured stdout/stderr for embedding into
 * a repair prompt. Outputs under the threshold are returned untouched (no
 * churn on small/passing gates). `changed` reports whether either stream was
 * modified; sizes let the caller annotate the prompt with the compression ratio.
 */
export function compressGateOutput(stdout: string, stderr: string): CompressedGateOutput {
  const originalChars = stdout.length + stderr.length;
  if (!GATE_OUTPUT_ENABLED || originalChars < GATE_OUTPUT_THRESHOLD_CHARS) {
    return { stdout, stderr, changed: false, originalChars, compressedChars: originalChars };
  }
  const cStdout = stdout ? compressStream(stdout) : "";
  const cStderr = stderr ? compressStream(stderr) : "";
  const compressedChars = cStdout.length + cStderr.length;
  const changed = cStdout !== stdout || cStderr !== stderr;
  return { stdout: cStdout, stderr: cStderr, changed, originalChars, compressedChars };
}
