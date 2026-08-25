import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to define mocks that are available before any imports.
const mocks = vi.hoisted(() => {
  const mockSearchNodes = vi.fn().mockReturnValue([]);
  const mockGetCallers = vi.fn().mockReturnValue([]);
  const mockGetCallees = vi.fn().mockReturnValue([]);
  const mockGetImpactRadius = vi.fn().mockReturnValue({ nodes: new Map(), edges: [], roots: [] });
  const mockGetOutgoingEdges = vi.fn().mockReturnValue([]);
  const mockSync = vi.fn().mockResolvedValue(undefined);
  const mockWatch = vi.fn().mockReturnValue(true);
  const mockClose = vi.fn();

  const mockInstance = {
    searchNodes: mockSearchNodes,
    getCallers: mockGetCallers,
    getCallees: mockGetCallees,
    getImpactRadius: mockGetImpactRadius,
    getOutgoingEdges: mockGetOutgoingEdges,
    sync: mockSync,
    watch: mockWatch,
    close: mockClose,
  };

  const mockOpen = vi.fn().mockResolvedValue(mockInstance);

  return {
    mockSearchNodes,
    mockGetCallers,
    mockGetCallees,
    mockGetImpactRadius,
    mockGetOutgoingEdges,
    mockSync,
    mockWatch,
    mockClose,
    mockInstance,
    mockOpen,
  };
});

vi.mock("@colbymchenry/codegraph", () => ({
  default: { CodeGraph: mocks.mockOpen.constructor === Function ? {} : { open: mocks.mockOpen } },
  CodeGraph: { open: mocks.mockOpen },
}));

const { CodeGraphService } = await import("../../../../application/harness/graph/code-graph.js");

describe("harness/graph/code-graph", () => {
  beforeEach(() => {
    // Clear instances first, then clear mock call counts.
    CodeGraphService.closeAll();
    vi.clearAllMocks();
    // Re-establish default mock implementations after clearAllMocks.
    mocks.mockOpen.mockResolvedValue(mocks.mockInstance);
    mocks.mockSearchNodes.mockReturnValue([]);
    mocks.mockGetCallers.mockReturnValue([]);
    mocks.mockGetCallees.mockReturnValue([]);
    mocks.mockGetImpactRadius.mockReturnValue({ nodes: new Map(), edges: [], roots: [] });
    mocks.mockGetOutgoingEdges.mockReturnValue([]);
    mocks.mockSync.mockResolvedValue(undefined);
    mocks.mockWatch.mockReturnValue(true);
    mocks.mockClose.mockImplementation(() => {});
  });

  // Existing tests (exercise static fallback)
  it("queries structural dependencies for a given file target", async () => {
    mocks.mockOpen.mockRejectedValueOnce(new Error("No .codegraph directory"));

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
    mocks.mockOpen.mockRejectedValueOnce(new Error("No .codegraph directory"));

    const result = await CodeGraphService.queryCodeGraph({
      queryType: "blast_radius",
      target: "WorkflowDefinition",
      depth: 2,
    });

    expect(result).toBeDefined();
    expect(result.queryType).toBe("blast_radius");
    expect(result.nodes.some(n => n.id === "WorkflowDefinition")).toBe(true);
  });

  // Library success path
  it("returns library data for dependencies query", async () => {
    mocks.mockSearchNodes.mockReturnValue([
      { node: { id: "n1", name: "schemas.ts", kind: "file", filePath: "src/core/schemas.ts", qualifiedName: "", language: "typescript", startLine: 1, endLine: 10, startColumn: 0, endColumn: 0, updatedAt: 0 } },
    ]);
    mocks.mockGetOutgoingEdges.mockReturnValue([
      { source: "n1", target: "n2", kind: "imports" },
    ]);

    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "schemas",
      depth: 2,
    });

    expect(mocks.mockOpen).toHaveBeenCalledOnce();
    expect(result.nodes.length).toBe(1);
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].relationship).toBe("imports");
    expect(result.summary).toContain("CodeGraph library");
  });

  it("returns library data for callers query", async () => {
    mocks.mockGetCallers.mockReturnValue([
      { node: { id: "c1", name: "caller1", kind: "function", qualifiedName: "", filePath: "", language: "typescript", startLine: 1, endLine: 5, startColumn: 0, endColumn: 0, updatedAt: 0 }, edge: { source: "c1", target: "target1", kind: "calls" } },
    ]);

    const result = await CodeGraphService.queryCodeGraph({
      queryType: "callers",
      target: "target1",
      depth: 2,
    });

    expect(result.nodes.length).toBe(2);
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].relationship).toBe("calls");
    expect(result.summary).toContain("1 caller(s)");
  });

  it("returns library data for callees query", async () => {
    mocks.mockGetCallees.mockReturnValue([
      { node: { id: "c1", name: "callee1", kind: "method", qualifiedName: "", filePath: "", language: "typescript", startLine: 1, endLine: 5, startColumn: 0, endColumn: 0, updatedAt: 0 }, edge: { source: "target1", target: "c1", kind: "calls" } },
    ]);

    const result = await CodeGraphService.queryCodeGraph({
      queryType: "callees",
      target: "target1",
      depth: 2,
    });

    expect(result.nodes.length).toBe(2);
    expect(result.edges.length).toBe(1);
    expect(result.summary).toContain("1 callee(s)");
  });

  it("returns library data for blast_radius query", async () => {
    const nodesMap = new Map([
      ["n1", { id: "n1", name: "target1", kind: "function", qualifiedName: "", filePath: "", language: "typescript", startLine: 1, endLine: 5, startColumn: 0, endColumn: 0, updatedAt: 0 }],
      ["n2", { id: "n2", name: "dep1", kind: "file", qualifiedName: "", filePath: "", language: "typescript", startLine: 1, endLine: 10, startColumn: 0, endColumn: 0, updatedAt: 0 }],
    ]);
    mocks.mockGetImpactRadius.mockReturnValue({
      nodes: nodesMap,
      edges: [{ source: "n2", target: "n1", kind: "imports" }],
      roots: ["n1"],
    });

    const result = await CodeGraphService.queryCodeGraph({
      queryType: "blast_radius",
      target: "target1",
      depth: 2,
    });

    expect(result.nodes.length).toBe(2);
    expect(result.edges.length).toBe(1);
    expect(result.summary).toContain("2 node(s)");
  });

  // Library failure → fallback
  it("falls back to static parser when library open throws", async () => {
    mocks.mockOpen.mockRejectedValueOnce(new Error("No .codegraph directory"));

    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "src/core/schemas.ts",
      depth: 2,
    });

    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.summary).toMatch(/^Static/);
  });

  it("falls back when library returns empty results", async () => {
    mocks.mockSearchNodes.mockReturnValue([]);

    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "nonexistent-module",
      depth: 2,
    });

    expect(result).toBeDefined();
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.summary).toMatch(/^Static/);
  });

  // Watcher lifecycle
  it("calls cg.watch() after first init", async () => {
    mocks.mockSearchNodes.mockReturnValue([]);

    await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "test",
      depth: 2,
    });

    expect(mocks.mockWatch).toHaveBeenCalledOnce();
    expect(mocks.mockSync).toHaveBeenCalledOnce();
  });

  it("calls cg.close() on closeAll()", async () => {
    mocks.mockSearchNodes.mockReturnValue([]);

    await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "test",
      depth: 2,
    });

    CodeGraphService.closeAll();
    expect(mocks.mockClose).toHaveBeenCalledOnce();
  });

  // Singleton caching
  it("reuses the same CodeGraph instance for the same root", async () => {
    mocks.mockSearchNodes.mockReturnValue([]);
    mocks.mockGetOutgoingEdges.mockReturnValue([]);

    await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "test1",
      depth: 2,
    });
    await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "test2",
      depth: 2,
    });

    expect(mocks.mockOpen).toHaveBeenCalledOnce();
  });

  it("creates separate instances for different roots", async () => {
    mocks.mockSearchNodes.mockReturnValue([]);
    mocks.mockGetOutgoingEdges.mockReturnValue([]);

    await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "test1",
      projectDir: "/root-a",
    });
    await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "test2",
      projectDir: "/root-b",
    });

    expect(mocks.mockOpen).toHaveBeenCalledTimes(2);
  });
});
