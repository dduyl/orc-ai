let _writeFn: ((text: string) => void) | undefined;

export function registerPtyWriter(fn: (text: string) => void): void {
  _writeFn = fn;
}

export function hasPtyWriter(): boolean {
  return _writeFn !== undefined;
}

export function notifyMainPty(text: string): void {
  const fn = _writeFn;
  if (!fn) return;
  fn(text);
  // Send the trailing <CR> after a delay — the opencode/PTY consumer discards
  // input that arrives in the same tick as the completion prompt, so an
  // immediate `fn("\r")` would be swallowed. 100 ms is an intentional delay,
  // not a race workaround to be removed (reviewer C1).
  setTimeout(() => fn("\r"), 100);
}
