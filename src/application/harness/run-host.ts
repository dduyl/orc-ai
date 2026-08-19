import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import type { IPty } from "node-pty";
import type { AdapterDef } from "../agents/adapter.js";
import { WorkflowRegistry } from "../planner/registry.js";
import { Tracker } from "./persistence/Tracker.js";
import type { ProgressEvent, RunReport } from "./orchestrator/index.js";
import { startRun } from "./start-run.js";
import { log } from "../../core/log.js";

/**
 * PTY sink hooks used only by the GUI topology. Headless hosts omit this and
 * rely on `hasPtyWriter()`-gated behavior instead.
 */
export interface PtySink {
  onStepPty(stepId: string, pty: IPty, agent: string): void;
  onWorkflowComplete(): void;
}

export interface RunHostOptions {
  projectDir?: string;
  tracker?: Tracker;
  ptySink?: PtySink;
  /** Injectable registry (e.g. a daemon pointed at a custom workflow dir). Defaults to the stock registry. */
  registry?: WorkflowRegistry;
  /**
   * ADR-022: explicit auto-resume delay (ms) for a paused run that has
   * no provider-reported reset window. Overrides the `quotaPauseDelayMs` value
   * in `~/.orc/config.json`; undefined defers to that config (absent config =
   * manual resume only).
   */
  quotaResumeDelayMs?: number;
}

/**
 * ADR-022: optional `quotaPauseDelayMs` in `~/.orc/config.json` — how
 * long a paused run waits before auto-resuming when the provider did not
 * report a reset time. Absent/invalid -> undefined (manual resume only).
 */
function loadQuotaResumeDelayMs(): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".orc", "config.json"), "utf8");
    const cfg = JSON.parse(raw) as { quotaPauseDelayMs?: number };
    return typeof cfg.quotaPauseDelayMs === "number" && cfg.quotaPauseDelayMs > 0
      ? cfg.quotaPauseDelayMs
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Transport-neutral run host.
 *
 * Owns host *concerns* only: resources (adapter, registry, projectDir,
 * tracker), the background-run identity map, and the progress fan-out.
 *
 * Deliberately NOT a god object: no orchestration mechanics, no agent/PTY
 * spawning, no MCP protocol, no run-lifecycle glue. The lifecycle lives in
 * the standalone `startRun()` in `./start-run.js`, which this host drives.
 */
export class RunHost {
  readonly adapter: AdapterDef;
  readonly registry: WorkflowRegistry;
  readonly projectDir?: string;
  readonly tracker: Tracker;
  /**
   * Keeps background orchestrate() Promises referenced so they are not
   * garbage-collected before they resolve. Also used by get_run_status to
   * await completion in headless (no-PTY) mode.
   */
  readonly bgRuns = new Map<string, Promise<RunReport>>();
  private readonly ptySink?: PtySink;
  /** ADR-022: pending quota-resume wake timers, keyed by runId. */
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();
  /** ADR-022: override for the config-driven auto-resume delay. */
  private readonly quotaResumeDelayMs?: number;

  constructor(adapter: AdapterDef, opts: RunHostOptions = {}) {
    this.adapter = adapter;
    this.registry = opts.registry ?? new WorkflowRegistry();
    this.projectDir = opts.projectDir;
    this.quotaResumeDelayMs = opts.quotaResumeDelayMs;
    // Default tracker root resolves from projectDir so runs.sqlite lives next to
    // checkpoints.sqlite (<projectDir>/.orc/), matching what the GUI's run-db
    // reads. Falls back to cwd (same as the Tracker default) when unset.
    this.tracker = opts.tracker ?? new Tracker(path.join(opts.projectDir ?? process.cwd(), ".orc", "runs.sqlite"));
    this.ptySink = opts.ptySink;
  }

  /** Transport-neutral progress fan-out. */
  onProgress(event: ProgressEvent): void {
    if (event.type === "step_pty") {
      if (event.pty && event.stepId && this.ptySink) {
        this.ptySink.onStepPty(event.stepId, event.pty, event.agent || event.stepId);
      }
      return;
    }
    if (event.type === "workflow_complete") {
      this.ptySink?.onWorkflowComplete();
    }
  }

  /**
   * ADR-022: schedule an auto-resume for a run paused by quota
   * exhaustion. With a known resetAtMs the wake fires at the reset instant;
   * without one (the provider did not say when) the `quotaPauseDelayMs` config
   * value in `~/.orc/config.json` is used. Returns false when no timer could be
   * scheduled (unknown reset + no config) — the run then resumes manually.
   */
  schedulePausedRunResume(runId: string, task: string, workflowId: string, resetAtMs?: number): boolean {
    let delayMs: number;
    if (resetAtMs !== undefined) {
      delayMs = Math.max(0, resetAtMs - Date.now());
    } else {
      const configured = this.quotaResumeDelayMs ?? loadQuotaResumeDelayMs();
      // A non-positive delay is never a valid resume window (the config loader
      // already enforces >0) — treat it as "manual resume only".
      if (configured === undefined || configured <= 0) return false;
      delayMs = configured;
    }
    this.clearPausedRunResume(runId);
    const timer = setTimeout(() => {
      this.wakeTimers.delete(runId);
      log.warn(`[run ${runId}] Quota window reset — resuming workflow "${workflowId}"`);
      void startRun(this, task, workflowId, true, { runId }).catch((err: any) => {
        log.warn(`[run ${runId}] Quota resume attempt failed: ${err?.message ?? err}`);
      });
    }, delayMs);
    timer.unref?.();
    this.wakeTimers.set(runId, timer);
    return true;
  }

  clearPausedRunResume(runId: string): void {
    const timer = this.wakeTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.wakeTimers.delete(runId);
    }
  }

  /** Cancel every pending quota-resume wake (daemon shutdown). */
  stopWakeTimers(): void {
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
  }
}