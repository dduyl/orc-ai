import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { RunLog, RunLogStore, RUN_LOG_MAX_BYTES } from "../../../../application/harness/daemon/run-log.js";

describe("RunLog (E1 disk-log retention)", () => {
  let dir: string;
  const newDir = (): string => {
    dir = mkdtempSync(path.join(os.tmpdir(), "orc-runlog-"));
    return dir;
  };

  it("persists frames in order and survives a re-open (restart)", () => {
    newDir();
    const p = path.join(dir, "r.log");
    const log = new RunLog(p);
    log.append("__main__", "line1");
    log.append("codegen", "line2");
    log.append("gate", "line3");
    expect(fs.existsSync(p)).toBe(true);

    const decoded = new RunLog(p).decode();
    expect(decoded.map((f) => f.stepId)).toEqual(["__main__", "codegen", "gate"]);
    expect(decoded.map((f) => f.payload.toString("utf8"))).toEqual(["line1", "line2", "line3"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips empty payloads (mirrors writeFrame)", () => {
    newDir();
    const log = new RunLog(path.join(dir, "r.log"));
    log.append("s", "");
    expect(log.decode()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("trims the oldest frames first when exceeding the per-run cap", () => {
    newDir();
    const p = path.join(dir, "r.log");
    // Fill ~6MB across 2 big frames; the cap (5MB) holds only the newest one.
    fs.writeFileSync(p, Buffer.alloc(0));
    const log = new RunLog(p);
    const big = "A".repeat(3 * 1024 * 1024);
    const big2 = "B".repeat(3 * 1024 * 1024);
    log.append("s1", big);
    log.append("s2", big2);

    const framed = new RunLog(p).decode();
    // Oldest (s1) must be evicted entirely; newest survives, under the cap.
    expect(framed.map((f) => f.stepId)).not.toContain("s1");
    expect(framed.map((f) => f.stepId)).toContain("s2");
    expect(fs.statSync(p).size).toBeLessThanOrEqual(RUN_LOG_MAX_BYTES);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("RunLogStore (E1 LRU eviction)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "orc-logstore-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("opens per-run logs and reports total bytes", () => {
    const store = new RunLogStore(dir, 100, 10);
    store.runLog("r1").append("s", "hello");
    store.runLog("r2").append("s", "world");
    expect(fs.existsSync(path.join(dir, "r1.log"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "r2.log"))).toBe(true);
    expect(store.count).toBe(2);
    expect(store.totalBytes()).toBeGreaterThan(0);
  });

  it("evicts the oldest run when the run-count cap is exceeded", () => {
    const store = new RunLogStore(dir, 1024 * 1024, 2);
    // Simulate differing mtimes: write r1, r2, sleep-scale r1 older by touching
    // r2 last.
    store.runLog("r1").append("s", "a".repeat(10));
    setTimeout(() => {}, 0);
    store.runLog("r2").append("s", "b".repeat(10));
    store.runLog("r3").append("s", "c".repeat(10));
    // force distinct mtimes where possible
    const r1 = path.join(dir, "r1.log");
    const now = new Date(Date.now() - 50_000);
    fs.utimesSync(r1, now, now);
    fs.utimesSync(path.join(dir, "r2.log"), new Date(Date.now() - 25_000), new Date(Date.now() - 25_000));
    store.enforceTotal();

    // Oldest (r1) evicted; newest two kept.
    expect(fs.existsSync(r1)).toBe(false);
    expect(fs.existsSync(path.join(dir, "r2.log"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "r3.log"))).toBe(true);
  });

  it("evicts oldest until total bytes are under the store cap", () => {
    const store = new RunLogStore(dir, 1000, 50);
    store.runLog("r1").append("s", "x".repeat(600));
    store.runLog("r2").append("s", "y".repeat(600));
    fs.utimesSync(path.join(dir, "r1.log"), new Date(Date.now() - 50_000), new Date(Date.now() - 50_000));
    store.enforceTotal();
    // r1 (600 bytes) + r2 (600) = 1200 > 1000 → r1 oldest evicted.
    expect(fs.existsSync(path.join(dir, "r1.log"))).toBe(false);
    expect(store.totalBytes()).toBeLessThanOrEqual(1000);
  });

  it("never evicts a live (active) run's log during enforceTotal", () => {
    const store = new RunLogStore(dir, 500, 50);
    // r2 is actively running (kept); r1 is the oldest idle log that must go.
    store.runLog("r1").append("s", "x".repeat(600));
    store.runLog("r2").append("s", "y".repeat(600));
    fs.utimesSync(path.join(dir, "r1.log"), new Date(Date.now() - 50_000), new Date(Date.now() - 50_000));
    store.enforceTotal(new Set(["r2"]));
    // r1 evicted to bring total under cap; r2 (live) survives regardless of mtime.
    expect(fs.existsSync(path.join(dir, "r1.log"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "r2.log"))).toBe(true);
  });
});