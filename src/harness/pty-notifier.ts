/**
 * pty-notifier.ts
 *
 * Thin bridge that lets tool-exec (MCP layer) push text into the main
 * agent PTY (opencode) without depending on Electron or gui/main.ts.
 *
 * In GUI mode:  gui/main.ts calls registerPtyWriter() at startup so
 *               notifyMainPty() writes directly into the opencode PTY.
 * In headless mode: _writeFn stays undefined and notifyMainPty() is a
 *               no-op; the headless fallback in get_run_status handles
 *               delivery instead.
 */

let _writeFn: ((text: string) => void) | undefined;

/** Called once by gui/main.ts after the main PTY is spawned. */
export function registerPtyWriter(fn: (text: string) => void): void {
  _writeFn = fn;
}

/** True when running inside the Electron GUI (main PTY available). */
export function hasPtyWriter(): boolean {
  return _writeFn !== undefined;
}

/**
 * Write text into the main agent PTY.
 * Appends "\r" so the terminal treats it as an Enter keystroke.
 * Safe to call in headless mode — becomes a no-op.
 */
export function notifyMainPty(text: string): void {
  _writeFn?.(text + "\r");
}
