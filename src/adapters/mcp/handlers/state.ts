import type { AdapterDef } from "../../../application/agents/adapter.js";
import type { ProgressEvent, RunReport } from "../../../application/harness/orchestrator/index.js";
import { Tracker } from "../../../application/harness/persistence/Tracker.js";
import { WorkflowRegistry } from "../../../application/planner/registry.js";

export let registry: WorkflowRegistry;
export let adapter: AdapterDef;
export let tracker: Tracker;
export let onProgress: ((event: ProgressEvent) => void) | undefined;
export let projectDir: string | undefined;

/**
 * Keeps background orchestrate() Promises referenced so they are not
 * garbage-collected before they resolve.  Also used by get_run_status
 * to await completion in headless (no-PTY) mode.
 */
export const bgRuns = new Map<string, Promise<RunReport>>();

export function init(adapterDef: AdapterDef, registryOpt?: WorkflowRegistry, onProgressOpt?: (event: ProgressEvent) => void, projectDirOpt?: string) {
  adapter = adapterDef;
  registry = registryOpt || new WorkflowRegistry();
  tracker = new Tracker();
  onProgress = onProgressOpt;
  projectDir = projectDirOpt;
}
