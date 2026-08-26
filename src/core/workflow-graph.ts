import type { WorkflowDefinition } from "./schemas.js";
import type { StepStatusRecord } from "../application/harness/persistence/Tracker.js";

export interface GraphNode {
  id: string;
  name: string;
  agent?: string;
  type: "agent" | "script";
  emits: string[];
  status: "pending" | "running" | "completed" | "failed" | "needs_human";
  duration?: number;
  error?: string;
  isGate: boolean;
  loopCount?: number;
  exitCode?: number;
  gate?: string;
  output?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  signal: string;
  kind: "on" | "any";
  matched: boolean;
}

export interface SignalEvent {
  timestamp: number;
  type: "emission" | "edge_match" | "gate_result" | "loop";
  stepId: string;
  signal?: string;
  toStep?: string;
  exitCode?: number;
  output?: string;
  iteration?: number;
  fromSignal?: string;
  reason?: string;
}

export interface WorkflowGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function buildGraphData(
  workflow: WorkflowDefinition,
  stepStatus: StepStatusRecord[]
): WorkflowGraphData {
  const statusById = new Map(stepStatus.map(s => [s.stepId, s]));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const step of workflow.workflow.steps) {
    const status = statusById.get(step.id);
    const isGate = step.type === "script";
    const node: GraphNode = {
      id: step.id,
      name: step.id,
      agent: step.agent,
      type: step.type,
      emits: step.emits.map(e => e.name),
      status: status?.status ?? "pending",
      duration: status?.duration ?? undefined,
      error: status?.error ?? undefined,
      isGate,
      // Loop counts arrive live via loop-detected events (canvas badge),
      // never from static topology or quota state.
    };
    if (isGate && status) {
      node.exitCode = status.status === "failed" ? 1 : 0;
      node.output = status.error ?? undefined;
      node.gate = step.run;
    }
    nodes.push(node);
  }

  for (const step of workflow.workflow.steps) {
    const refs = [
      ...(step.on ?? []).map((ref): { ref: string; kind: "on" | "any" } => ({ ref, kind: "on" })),
      ...(step.any ?? []).map((ref): { ref: string; kind: "on" | "any" } => ({ ref, kind: "any" })),
    ];
    for (const { ref, kind } of refs) {
      if (ref === "__start__") continue;
      const dot = ref.lastIndexOf(".");
      const from = ref.slice(0, dot);
      const signal = ref.slice(dot + 1);
      edges.push({
        from,
        to: step.id,
        signal,
        kind,
        matched: false,
      });
    }
  }

  return { nodes, edges };
}