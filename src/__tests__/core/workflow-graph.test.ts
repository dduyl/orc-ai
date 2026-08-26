import { describe, it, expect } from "vitest";
import { WorkflowDefinition } from "../../core/schemas.js";
import { buildGraphData, type WorkflowGraphData } from "../../core/workflow-graph.js";
import type { StepStatusRecord } from "../../application/harness/persistence/Tracker.js";

function makeWorkflow(overrides: Partial<WorkflowDefinition["workflow"]> = {}): WorkflowDefinition {
  return {
    version: 1,
    workflow: {
      id: "test_workflow",
      name: "Test Workflow",
      steps: [
        {
          id: "spec",
          type: "agent",
          agent: "requirement_analyst",
          emits: [{ name: "sig_done", description: "Spec complete" }],
          on: ["__start__"],
          task: "Analyze requirements",
          context: [],
        },
        {
          id: "code",
          type: "agent",
          agent: "code_generation_backend",
          emits: [{ name: "sig_done", description: "Code complete" }],
          on: ["spec.sig_done"],
          task: "Generate code",
          context: [],
        },
        {
          id: "validate",
          type: "script",
          run: 'cmd "validate"',
          emits: [
            { name: "sig_pass", description: "Validation passed" },
            { name: "sig_fail", description: "Validation failed" },
          ],
          on: ["code.sig_done"],
          context: [],
        },
      ],
      completion: "Done",
      ...overrides,
    },
  };
}

function makeStatus(overrides: Partial<StepStatusRecord>[] = []): StepStatusRecord[] {
  return overrides.map(o => ({
    stepId: o.stepId ?? "",
    status: o.status ?? "pending",
    agent: o.agent ?? null,
    task: o.task ?? null,
    signals: o.signals ?? [],
    duration: o.duration ?? null,
    error: o.error ?? null,
    quota: o.quota ?? null,
    startedAt: o.startedAt ?? null,
    completedAt: o.completedAt ?? null,
  }));
}

describe("buildGraphData", () => {
  it("creates nodes for all steps with correct properties", () => {
    const wf = makeWorkflow();
    const status = makeStatus([
      { stepId: "spec", status: "completed", duration: 3 },
      { stepId: "code", status: "running", duration: 5 },
      { stepId: "validate", status: "pending" },
    ]);
    const graph = buildGraphData(wf, status);

    expect(graph.nodes).toHaveLength(3);

    const specNode = graph.nodes.find(n => n.id === "spec");
    expect(specNode).toEqual(expect.objectContaining({
      id: "spec",
      type: "agent",
      agent: "requirement_analyst",
      emits: ["sig_done"],
      status: "completed",
      duration: 3,
      isGate: false,
    }));

    const codeNode = graph.nodes.find(n => n.id === "code");
    expect(codeNode?.status).toBe("running");

    const validateNode = graph.nodes.find(n => n.id === "validate");
    expect(validateNode?.isGate).toBe(true);
    expect(validateNode?.type).toBe("script");
  });

  it("creates edges for signal dependencies", () => {
    const wf = makeWorkflow();
    const graph = buildGraphData(wf, []);

    expect(graph.edges).toHaveLength(2);
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: "spec",
      to: "code",
      signal: "sig_done",
      kind: "on",
      matched: false,
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: "code",
      to: "validate",
      signal: "sig_done",
      kind: "on",
      matched: false,
    }));
  });

  it("handles any edges (OR join)", () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: "spec",
          type: "agent",
          agent: "requirement_analyst",
          emits: [{ name: "sig_done", description: "Spec complete" }],
          on: ["__start__"],
          task: "Analyze requirements",
          context: [],
        },
        {
          id: "code",
          type: "agent",
          agent: "code_generation_backend",
          emits: [{ name: "sig_done", description: "Code complete" }],
          any: ["spec.sig_done", "review.sig_fail"],
          task: "Generate code",
          context: [],
        },
      ],
    });
    const graph = buildGraphData(wf, []);

    expect(graph.edges).toHaveLength(2);
    const anyEdge = graph.edges.find(e => e.kind === "any");
    expect(anyEdge).toBeDefined();
    expect(anyEdge?.from).toBe("spec");
    expect(anyEdge?.to).toBe("code");
  });

  it("ignores __start__ references", () => {
    const wf = makeWorkflow();
    const graph = buildGraphData(wf, []);

    const startEdge = graph.edges.find(e => e.from === "__start__");
    expect(startEdge).toBeUndefined();
  });

  it("marks gate nodes correctly for script steps", () => {
    const wf = makeWorkflow();
    const graph = buildGraphData(wf, []);

    const validateNode = graph.nodes.find(n => n.id === "validate");
    expect(validateNode?.isGate).toBe(true);
    expect(validateNode?.type).toBe("script");
  });

  it("propagates needs_human status to graph nodes without error", () => {
    const wf = makeWorkflow();
    const status = makeStatus([
      { stepId: "spec", status: "needs_human" },
      { stepId: "code", status: "running" },
      { stepId: "validate", status: "pending" },
    ]);
    const graph = buildGraphData(wf, status);

    const specNode = graph.nodes.find(n => n.id === "spec");
    expect(specNode?.status).toBe("needs_human");
  });
});

describe("WorkflowGraphData types", () => {
  it("GraphNode has all required fields", () => {
    const node = {
      id: "test",
      name: "test",
      agent: "test_agent",
      type: "agent" as const,
      emits: ["sig_done"],
      status: "pending" as const,
      duration: undefined,
      error: undefined,
      isGate: false,
    };
    expect(node.id).toBe("test");
    expect(node.isGate).toBe(false);
  });

  it("GraphEdge has correct structure", () => {
    const edge = {
      from: "spec",
      to: "code",
      signal: "sig_done",
      kind: "on" as const,
      matched: false,
    };
    expect(edge.kind).toBe("on");
  });

  it("SignalEvent types are valid", () => {
    const emission: import("../../core/workflow-graph.js").SignalEvent = {
      timestamp: Date.now(),
      type: "emission",
      stepId: "spec",
      signal: "sig_done",
    };
    expect(emission.type).toBe("emission");

    const edgeMatch: import("../../core/workflow-graph.js").SignalEvent = {
      timestamp: Date.now(),
      type: "edge_match",
      stepId: "spec",
      signal: "sig_done",
      toStep: "code",
    };
    expect(edgeMatch.type).toBe("edge_match");

    const gateResult: import("../../core/workflow-graph.js").SignalEvent = {
      timestamp: Date.now(),
      type: "gate_result",
      stepId: "validate",
      exitCode: 1,
      output: "failed",
    };
    expect(gateResult.type).toBe("gate_result");

    const loop: import("../../core/workflow-graph.js").SignalEvent = {
      timestamp: Date.now(),
      type: "loop",
      stepId: "code",
      iteration: 2,
      reason: "gate failed",
      fromSignal: "sig_fail",
    };
    expect(loop.type).toBe("loop");
  });
});