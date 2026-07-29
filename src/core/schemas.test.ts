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
  });
});
