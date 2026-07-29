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
  setTimeout(() => fn("\r"), 100);
}
