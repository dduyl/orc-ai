interface Deferred {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

const registry = new Map<string, Deferred>();

export function registerCompletion(key: string): Promise<any> {
  if (registry.has(key)) {
    throw new Error(`Completion key "${key}" already registered`);
  }
  return new Promise<any>((resolve, reject) => {
    registry.set(key, { resolve, reject });
  });
}

export function resolveCompletion(key: string, data: any): void {
  const d = registry.get(key);
  if (!d) return;
  registry.delete(key);
  d.resolve(data);
}

export function rejectCompletion(key: string, err: Error): void {
  const d = registry.get(key);
  if (!d) return;
  registry.delete(key);
  d.reject(err);
}

export function completionKeyExists(key: string): boolean {
  return registry.has(key);
}
