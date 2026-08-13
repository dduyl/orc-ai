import { describe, it, expect } from "vitest";
import { CodeGraphService } from "../../../../application/harness/graph/code-graph.js";

describe("harness/graph/code-graph", () => {
  it("queries structural dependencies for a given file target", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "src/core/schemas.ts",
      depth: 2,
    });

    expect(result).toBeDefined();
    expect(result.queryType).toBe("dependencies");
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.summary).toBeTruthy();
  });

  it("queries blast radius for a symbol target", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "blast_radius",
      target: "WorkflowDefinition",
      depth: 2,
    });

    expect(result).toBeDefined();
    expect(result.queryType).toBe("blast_radius");
    expect(result.nodes.some(n => n.id === "WorkflowDefinition")).toBe(true);
  });
});
