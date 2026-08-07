import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { encodeFrame, FrameReader } from "./frame-transport.js";

/**
 * Finished-run terminal retention on disk (ADR-025 Phase E decision #16).
 *
 * Each run gets an append-only log at `{projectDir}/.orc/runs/<runId>.log` of
 * the SAME length-prefixed frames the terminal channel uses
 * (`frame-transport.ts`), so log replay and live transport share one codec.
 * Step attribution + byte order survive; `SCREEN_STEP_ID`/`MAIN_STEP_ID` and
 * the zero-length EOF frame are replayed verbatim. A fresh headless terminal
 * fed the log frames reproduces the original screen, letting a finished/evicted
 * run be re-attached after a daemon restart (cold restore) or from the hot cache.
 *
 * Caps are Orca-style: ~5 MB per run (oldest frames trimmed head-first) and a
 * store-wide ~50 MB / ~100 runs true-LRU eviction of oldest finished logs.
 * Flush is eager by default ("viewing successful runs") — every frame is
 * durable immediately, no on-success batched flush gate.
 */

export const RUN_LOG_MAX_BYTES = 5 * 1024 * 1024; // per-run cap
export const RUN_LOG_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // total store cap
export const RUN_LOG_MAX_RUNS = 100; // total run-log count cap

/**
 * A single run's append-only on-disk log. Appends are synchronous + durable so
 * a daemon crash mid-run still leaves a replayable log (the boot reconciler
 * marks the run failed but the bytes survive). Trimming drops the OLDEST
 * frames head-first, preserving the newest output + byte order.
 */
export class RunLog {
  private bytes = 0;

  constructor(readonly path: string) {
    this.bytes = existsSync(path) ? statSync(path).size : 0;
  }

  /** Append one framed write and enforce the per-run cap (oldest-first trim). */
  append(stepId: string, payload: Buffer | string): void {
    const byteLen = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload, "utf8");
    if (byteLen === 0) return; // an empty payload carries no info (mirrors writeFrame)
    const frame = encodeFrame(stepId, payload);
    writeFileSync(this.path, frame, { flag: "a" });
    this.bytes += frame.length;
    if (this.bytes > RUN_LOG_MAX_BYTES) this.trimTo(RUN_LOG_MAX_BYTES);
  }

  /** Rewrite the file keeping only the TAIL of frames within `maxBytes` (oldest dropped). */
  private trimTo(maxBytes: number): void {
    const frames = this.decode();
    const kept: Buffer[] = [];
    let keptBytes = 0;
    // Walk newest→oldest so the retained suffix keeps the most recent output.
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = encodeFrame(frames[i].stepId, frames[i].payload);
      if (keptBytes + frame.length > maxBytes) continue;
      keptBytes += frame.length;
      kept.push(frame);
    }
    kept.reverse();
    this.bytes = keptBytes;
    if (keptBytes === 0) {
      try { rmSync(this.path, { force: true }); } catch { /* ignore */ }
      return;
    }
    writeFileSync(this.path, Buffer.concat(kept));
  }

  /** Decode the entire log back into ordered frames (survives restart). */
  decode(): { stepId: string; payload: Buffer }[] {
    if (!existsSync(this.path)) return [];
    const buf = readFileSync(this.path);
    if (buf.length === 0) return [];
    const reader = new FrameReader();
    const out: { stepId: string; payload: Buffer }[] = [];
    reader.onFrame = (f) => out.push({ stepId: f.stepId, payload: Buffer.from(f.payload) });
    reader.feed(buf);
    return out;
  }

  get byteSize(): number {
    return this.bytes;
  }
}

/**
 * Directory-scoped store over run logs with total-store cap + true-LRU
 * eviction. Finished runs are the natural eviction targets: once a terminal
 * finalizes its log it is immutable, so eviction order = oldest mtime (LRU).
 */
export class RunLogStore {
  private logs = new Map<string, RunLog>();

  constructor(
    private runsDir: string,
    private maxTotalBytes: number = RUN_LOG_MAX_TOTAL_BYTES,
    private maxRuns: number = RUN_LOG_MAX_RUNS,
  ) {}

  /** Path for a run's log file (even if not yet created). */
  pathFor(runId: string): string {
    return join(this.runsDir, `${runId}.log`);
  }

  /** Whether a run has a non-empty durable log on disk. */
  exists(runId: string): boolean {
    try { return statSync(this.pathFor(runId)).size > 0; } catch { return false; }
  }

  /** Open (or return the cached) log for a run, creating the directory. */
  runLog(runId: string): RunLog {
    let log = this.logs.get(runId);
    if (!log) {
      mkdirSync(this.runsDir, { recursive: true });
      log = new RunLog(this.pathFor(runId));
      this.logs.set(runId, log);
    }
    return log;
  }

  /** Total on-disk bytes across managed run logs. */
  totalBytes(): number {
    let total = 0;
    for (const log of this.logs.values()) total += log.byteSize;
    return total;
  }

  /**
   * Enforce store caps: evict NEWEST logs that fit the caps (oldest-first drop
   * would keep newest, but a finished run's log is evictable only once > caps)
   * — true-LRU means the OLDEST logs go first. Deletes oldest until total bytes
   * ≤ maxTotalBytes AND managed count ≤ maxRuns. Called when a run finalizes.
   *
   * Logs for `activeRunIds` are never evicted: a still-running run's log is
   * live (its `RunLog` keeps appending via `{flag:'a'}`), so deleting the file
   * would drop already-persisted bytes, silently recreate it on the next append
   * and desync `totalBytes()` from the live `RunLog` object.
   */
  enforceTotal(activeRunIds: ReadonlySet<string> = new Set()): void {
    let size = this.totalBytes();
    let count = this.logs.size;
    // Oldest first (lowest mtime).
    const byOldest = [...this.logs.values()]
      .map((l) => ({ run: l, runId: runIdOf(l.path), mtime: this.mtimeOf(l.path) }))
      .sort((a, b) => a.mtime - b.mtime);
    for (const entry of byOldest) {
      if (size <= this.maxTotalBytes && count <= this.maxRuns) break;
      // Skip live runs so a concurrent run's disk log survives until it finishes.
      if (entry.runId && activeRunIds.has(entry.runId)) continue;
      try { rmSync(entry.run.path, { force: true }); } catch { /* ignore */ }
      if (entry.runId) this.logs.delete(entry.runId);
      size -= entry.run.byteSize;
      count--;
    }
  }

  private mtimeOf(p: string): number {
    try { return statSync(p).mtimeMs; } catch { return Number.MIN_SAFE_INTEGER; }
  }

  get count(): number {
    return this.logs.size;
  }

  /** Drop a run from the manager without deleting its file (evictTerminal path). */
  drop(runId: string): void {
    this.logs.delete(runId);
  }
}

function runIdOf(logPath: string): string | undefined {
  const name = basename(logPath);
  if (!name.endsWith(".log")) return undefined;
  return name.slice(0, -4);
}