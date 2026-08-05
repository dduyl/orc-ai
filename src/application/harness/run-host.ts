import * as path from "node:path";
import type { IPty } from "node-pty";
import type { AdapterDef } from "../agents/adapter.js";
import { WorkflowRegistry } from "../planner/registry.js";
import { Tracker } from "./persistence/Tracker.js";
import type { ProgressEvent, RunReport } from "./orchestrator/index.js";

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

  constructor(adapter: AdapterDef, opts: RunHostOptions = {}) {
    this.adapter = adapter;
    this.registry = new WorkflowRegistry();
    this.projectDir = opts.projectDir;
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
}