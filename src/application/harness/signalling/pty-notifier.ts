let _writeFn: ((text: string) => void) | undefined;

export function registerPtyWriter(fn: (text: string) => void): void {
  _writeFn = fn;
}

export function hasPtyWriter(): boolean {
  return _writeFn !== undefined;
}

export function notifyMainPty(text: string): void {
  _writeFn?.(text + "\r");
}
