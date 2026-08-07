import type { AdapterDef } from "../../../application/agents/adapter.js";
import type { RunReport } from "../../../application/harness/orchestrator/index.js";
import type { Tracker } from "../../../application/harness/persistence/Tracker.js";
import type { WorkflowRegistry } from "../../../application/planner/registry.js";
import type { RunHost } from "../../../application/harness/run-host.js";

/**
 * Thin binding to the active `RunHost`. The harness owns the single source of
 * truth (adapter, registry, tracker, projectDir, bgRuns); this module just
 * re-exports them so MCP handlers keep their existing imports.
 */
export let host: RunHost;

export let registry: WorkflowRegistry;
export let adapter: AdapterDef;
export let tracker: Tracker;
export let projectDir: string | undefined;
export let bgRuns: Map<string, Promise<RunReport>>;

export function init(hostInstance: RunHost): void {
  host = hostInstance;
  adapter = hostInstance.adapter;
  registry = hostInstance.registry;
  tracker = hostInstance.tracker;
  projectDir = hostInstance.projectDir;
  bgRuns = hostInstance.bgRuns;
}
