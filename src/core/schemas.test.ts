import { describe, it, expect } from "vitest";
import { WorkflowDefinition, SpecEntry, ChangeLogEntry, validateWorkflowGraph } from "./schemas.js";

const sig = (name: string) => ({ name, description: "desc" });

describe("schemas", () => {
  it("validates spec entry", () => {
    const spec = SpecEntry.parse({
      schemaVersion: 1,
      id: "spec-1",
      title: "Test Spec",
      summary: "Summary",
      affectedModules: ["mod1"],
      tags: ["tag1"],
      filePath: "/path/to/spec",
    });
    expect(spec.id).toBe("spec-1");
  });

  it("validates workflow definition", () => {
    const wf = WorkflowDefinition.parse({
      version: 1,
      workflow: {
        id: "wf-1",
        name: "Test WF",
        steps: [
          { id: "step-1", agent: "analyst", emits: [sig("done")], on: ["__start__"] },
        ],
        completion: "Done",
      },
    });
    expect(wf.workflow.steps[0].emits[0].name).toBe("done");
    expect(wf.workflow.steps[0].type).toBe("agent");
  });

  it("defaults step type to agent", () => {
    const wf = WorkflowDefinition.parse({
      version: 1,
      workflow: {
        id: "wf-2",
        name: "Test WF",
        steps: [{ id: "s1", agent: "analyst", emits: [sig("done")], on: ["__start__"] }],
        completion: "Done",
      },
    });
    expect(wf.workflow.steps[0].type).toBe("agent");
  });

  it("accepts a script step with exec", () => {
    const wf = WorkflowDefinition.parse({
      version: 1,
      workflow: {
        id: "wf-3",
        name: "Test WF",
        steps: [{ id: "s1", type: "script", run: 'exec "exit 0"', emits: [sig("p"), sig("f")], on: ["__start__"] }],
        completion: "Done",
      },
    });
    expect(wf.workflow.steps[0].type).toBe("script");
  });

  it("accepts a script step with cmd", () => {
    const wf = WorkflowDefinition.parse({
      version: 1,
      workflow: {
        id: "wf-4",
        name: "Test WF",
        steps: [{ id: "s1", type: "script", run: 'cmd "test.unit"', emits: [sig("p"), sig("f")], on: ["__start__"] }],
        completion: "Done",
      },
    });
    expect(wf.workflow.steps[0].run).toBe('cmd "test.unit"');
  });

  it("rejects a script step that also declares an agent", () => {
    expect(() =>
      WorkflowDefinition.parse({
        version: 1,
        workflow: {
          id: "wf-5",
          name: "Test WF",
          steps: [{ id: "s1", type: "script", agent: "analyst", run: 'exec "exit 0"', emits: [sig("p"), sig("f")], on: ["__start__"] }],
          completion: "Done",
        },
      }),
    ).toThrow();
  });

  it("rejects a script step with no run expression", () => {
    expect(() =>
      WorkflowDefinition.parse({
        version: 1,
        workflow: {
          id: "wf-6",
          name: "Test WF",
          steps: [{ id: "s1", type: "script", emits: [sig("p"), sig("f")], on: ["__start__"] }],
          completion: "Done",
        },
      }),
    ).toThrow();
  });

  it("rejects an agent step that declares run", () => {
    expect(() =>
      WorkflowDefinition.parse({
        version: 1,
        workflow: {
          id: "wf-8",
          name: "Test WF",
          steps: [{ id: "s1", agent: "analyst", run: 'exec "exit 0"', emits: [sig("done")], on: ["__start__"] }],
          completion: "Done",
        },
      }),
    ).toThrow();
  });

  it("rejects a step declaring neither on nor any", () => {
    expect(() =>
      WorkflowDefinition.parse({
        version: 1,
        workflow: {
          id: "wf-9",
          name: "Test WF",
          steps: [{ id: "s1", agent: "analyst", emits: [sig("done")] }],
          completion: "Done",
        },
      }),
    ).toThrow();
  });

  it("rejects a step declaring both on and any", () => {
    expect(() =>
      WorkflowDefinition.parse({
        version: 1,
        workflow: {
          id: "wf-10",
          name: "Test WF",
          steps: [{ id: "s1", agent: "analyst", emits: [sig("done")], on: ["__start__"], any: ["__start__"] }],
          completion: "Done",
        },
      }),
    ).toThrow();
  });

  it("rejects duplicate emit names", () => {
    expect(() =>
      WorkflowDefinition.parse({
        version: 1,
        workflow: {
          id: "wf-11",
          name: "Test WF",
          steps: [{ id: "s1", agent: "analyst", emits: [sig("done"), sig("done")], on: ["__start__"] }],
          completion: "Done",
        },
      }),
    ).toThrow();
  });

  it("rejects a script step emitting != 2 signals", () => {
    expect(() =>
      WorkflowDefinition.parse({
        version: 1,
        workflow: {
          id: "wf-12",
          name: "Test WF",
          steps: [{ id: "s1", type: "script", run: 'cmd "x"', emits: [sig("p")], on: ["__start__"] }],
          completion: "Done",
        },
      }),
    ).toThrow();
  });

  it("graph validation flags an unknown step", () => {
    const def = (steps: Array<Record<string, unknown>>) =>
      ({ version: 1, workflow: { id: "wf-x", name: "X", steps, completion: "Done" } }) as WorkflowDefinition;
    const issues = validateWorkflowGraph(def([{ id: "s1", agent: "analyst", emits: [sig("done")], on: ["__start__"] }]));
    expect(issues.some(i => i.message.includes("unknown"))).toBe(false);
    const bad = validateWorkflowGraph(def([
      { id: "s1", agent: "analyst", emits: [sig("done")], on: ["__start__"] },
      { id: "s2", agent: "analyst", emits: [sig("done")], on: ["ghost.done"] },
    ]));
    expect(bad.some(i => i.message.includes("unknown"))).toBe(true);
  });

  it("graph validation flags a signal not in the producer's emits", () => {
    const def = (steps: Array<Record<string, unknown>>) =>
      ({ version: 1, workflow: { name: "X", steps, completion: "Done" } }) as WorkflowDefinition;
    const issues = validateWorkflowGraph(def([
      { id: "s1", agent: "analyst", emits: [sig("done")], on: ["__start__"] },
      { id: "s2", agent: "analyst", emits: [sig("done")], on: ["s1.missing"] },
    ]));
    expect(issues.some(i => i.message.includes("does not emit"))).toBe(true);
  });

  it("graph validation flags unreachable steps", () => {
    const def = (steps: Array<Record<string, unknown>>) =>
      ({ version: 1, workflow: { name: "X", steps, completion: "Done" } }) as WorkflowDefinition;
    const issues = validateWorkflowGraph(def([
      { id: "s1", agent: "analyst", emits: [sig("done")], on: ["__start__"] },
      { id: "s2", agent: "analyst", emits: [sig("done")], on: ["s3.done"] },
      { id: "s3", agent: "analyst", emits: [sig("done")], on: ["s2.done"] },
    ]));
    expect(issues.filter(i => i.message.includes("unreachable")).length).toBeGreaterThanOrEqual(2);
  });

  it("graph validation passes a valid graph", () => {
    const def = (steps: Array<Record<string, unknown>>) =>
      ({ version: 1, workflow: { name: "X", steps, completion: "Done" } }) as WorkflowDefinition;
    const issues = validateWorkflowGraph(def([
      { id: "s1", agent: "analyst", emits: [sig("done")], on: ["__start__"] },
      { id: "s2", agent: "analyst", emits: [sig("done")], on: ["s1.done"] },
    ]));
    expect(issues).toEqual([]);
  });

  it("graph validation flags duplicate step ids", () => {
    const def = (steps: Array<Record<string, unknown>>) =>
      ({ version: 1, workflow: { name: "X", steps, completion: "Done" } }) as WorkflowDefinition;
    const issues = validateWorkflowGraph(def([
      { id: "s1", agent: "analyst", emits: [sig("done")], on: ["__start__"] },
      { id: "s1", agent: "analyst", emits: [sig("done")], on: ["s1.done"] },
    ]));
    expect(issues.some(i => i.message.includes("duplicate step id"))).toBe(true);
  });

  it("rejects step ids containing a dot (would corrupt stepId.signalName refs)", () => {
    expect(() =>
      WorkflowDefinition.parse({
        version: 1,
        workflow: {
          name: "X",
          steps: [{ id: "a.b", agent: "analyst", emits: [sig("done")], on: ["__start__"] }],
          completion: "Done",
        },
      }),
    ).toThrow(/step id/);
  });

  it("rejects signal names containing a dot", () => {
    expect(() =>
      WorkflowDefinition.parse({
        version: 1,
        workflow: {
          name: "X",
          steps: [{ id: "s1", agent: "analyst", emits: [sig("done.more")], on: ["__start__"] }],
          completion: "Done",
        },
      }),
    ).toThrow(/signal name/);
  });
});
