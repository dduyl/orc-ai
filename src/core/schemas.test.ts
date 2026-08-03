import { describe, it, expect } from "vitest";
import { WorkflowDefinition, SpecEntry, ChangeLogEntry } from "./schemas.js";

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
          { id: "step-1", agent: "analyst" },
        ],
        completion: "Done",
      },
    });
    expect(wf.workflow.steps[0].depends_on).toEqual([]);
    expect(wf.workflow.steps[0].type).toBe("agent");
  });

  it("defaults step type to agent", () => {
    const wf = WorkflowDefinition.parse({
      version: 1,
      workflow: {
        id: "wf-2",
        name: "Test WF",
        steps: [{ id: "s1", agent: "analyst" }],
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
        steps: [{ id: "s1", type: "script", run: 'exec "exit 0"' }],
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
        steps: [{ id: "s1", type: "script", run: 'cmd "test.unit"' }],
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
          steps: [{ id: "s1", type: "script", agent: "analyst", run: 'exec "exit 0"' }],
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
          steps: [{ id: "s1", type: "script" }],
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
          steps: [{ id: "s1", agent: "analyst", run: 'exec "exit 0"' }],
          completion: "Done",
        },
      }),
    ).toThrow();
  });
});
