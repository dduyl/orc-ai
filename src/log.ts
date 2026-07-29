type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  timestamp: number;
  message: string;
}

type LogListener = (entry: LogEntry) => void;

class Logger {
  private entries: LogEntry[] = [];
  private listeners: LogListener[] = [];
  private teeToStderr = true;

  setTeeToStderr(v: boolean): void {
    this.teeToStderr = v;
  }

  debug(...args: any[]): void {
    this.emit("debug", args);
  }

  info(...args: any[]): void {
    this.emit("info", args);
  }

  warn(...args: any[]): void {
    this.emit("warn", args);
  }

  error(...args: any[]): void {
    this.emit("error", args, true);
  }

  private emit(level: LogLevel, args: any[], isError = false): void {
    const message = args
      .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
    const entry: LogEntry = { level, timestamp: Date.now(), message };
    this.entries.push(entry);
    for (const fn of this.listeners) fn(entry);
    if (isError) {
      console.error(...args);
    } else if (this.teeToStderr) {
      process.stderr.write(`[${level.toUpperCase()}] ${message}\n`);
    }
  }

  subscribe(fn: LogListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  getEntries(): LogEntry[] {
    return this.entries;
  }
}

export const log = new Logger();
