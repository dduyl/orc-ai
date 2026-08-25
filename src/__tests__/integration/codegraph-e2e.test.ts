import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeGraphService } from "../../application/harness/graph/code-graph.js";

/**
 * Integration test: exercises the full codegraph data flow end-to-end
 * without mocking @colbymchenry/codegraph.
 *
 * The library native binary is not available in CI, so this test exercises
 * the static regex fallback path with real TypeScript source files.
 *
 * What it validates:
 * - Real filesystem parsing (import/dependency extraction)
 * - All four query types (dependencies, callers, callees, blast_radius)
 * - File targets and symbol targets
 * - Result shape (nodes have id/name/type, edges have source/target/relationship)
 * - Summary string format (fallback starts with "Static")
 * - closeAll() lifecycle (clears instances, no errors)
 * - Graceful degradation for unknown targets
 */

let tmpRoot: string;

const SRC_FILES: Record<string, string> = {
  "src/main.ts": [
    `import { helper } from "./utils.js";`,
    `import { fetchData } from "./service.js";`,
    ``,
    `export function run() {`,
    `  const h = helper("hello");`,
    `  const d = fetchData(h);`,
    `  return d;`,
    `}`,
  ].join("\n"),
  "src/utils.ts": [
    `export function helper(input: string): string {`,
    `  return input.toUpperCase();`,
    `}`,
    ``,
    `export function format(data: unknown): string {`,
    `  return JSON.stringify(data);`,
    `}`,
  ].join("\n"),
  "src/service.ts": [
    `import { format } from "./utils.js";`,
    ``,
    `export async function fetchData(query: string) {`,
    `  const result = await fetch(\`/api?q=\${query}\`);`,
    `  return format(result);`,
    `}`,
  ].join("\n"),
  "src/models.ts": [
    `export interface User {`,
    `  id: string;`,
    `  name: string;`,
    `}`,
    ``,
    `export interface Config {`,
    `  apiUrl: string;`,
    `}`,
  ].join("\n"),
};

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orc-codegraph-integ-"));
  for (const [rel, content] of Object.entries(SRC_FILES)) {
    const fullPath = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }
});

afterAll(() => {
  CodeGraphService.closeAll();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("codegraph integration: full data flow", () => {
  // ─── Result shape validation ───────────────────────────────────────

  it("returns valid result shape for dependencies query", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: path.join("src", "main.ts"),
      projectDir: tmpRoot,
    });

    expect(result).toBeDefined();
    expect(result.queryType).toBe("dependencies");
    expect(result.target).toBeTruthy();
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
    expect(typeof result.summary).toBe("string");

    // Every node has required fields
    for (const node of result.nodes) {
      expect(typeof node.id).toBe("string");
      expect(typeof node.name).toBe("string");
      expect(["file", "symbol", "module"]).toContain(node.type);
    }

    // Every edge has required fields
    for (const edge of result.edges) {
      expect(typeof edge.source).toBe("string");
      expect(typeof edge.target).toBe("string");
      expect(["imports", "calls", "depends_on"]).toContain(edge.relationship);
    }
  });

  // ─── File target: dependencies ─────────────────────────────────────

  it("parses real imports for a file target", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: path.join("src", "main.ts"),
      projectDir: tmpRoot,
    });

    // main.ts imports from utils.ts and service.ts — at least those edges
    expect(result.edges.length).toBeGreaterThanOrEqual(2);

    const importEdges = result.edges.filter(e => e.relationship === "imports");
    expect(importEdges.length).toBeGreaterThanOrEqual(2);

    // All import edges originate from main.ts (or its relative path)
    for (const edge of importEdges) {
      expect(edge.source).toContain("main");
    }
  });

  // ─── File target: blast_radius ─────────────────────────────────────

  it("returns blast_radius result for a file target", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "blast_radius",
      target: path.join("src", "utils.ts"),
      projectDir: tmpRoot,
    });

    expect(result.queryType).toBe("blast_radius");
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.summary).toBeTruthy();

    // utils.ts is imported by main.ts and service.ts — should have some blast radius
    const fileNodes = result.nodes.filter(n => n.type === "file");
    expect(fileNodes.length).toBeGreaterThanOrEqual(1);
  });

  // ─── File target: callers ──────────────────────────────────────────

  it("returns callers result for a file target", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "callers",
      target: path.join("src", "utils.ts"),
      projectDir: tmpRoot,
    });

    expect(result.queryType).toBe("callers");
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  // ─── File target: callees ──────────────────────────────────────────

  it("returns callees result for a file target", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "callees",
      target: path.join("src", "main.ts"),
      projectDir: tmpRoot,
    });

    expect(result.queryType).toBe("callees");
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  // ─── Symbol target ────────────────────────────────────────────────

  it("finds symbol references across files", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "blast_radius",
      target: "helper",
      projectDir: tmpRoot,
    });

    expect(result.queryType).toBe("blast_radius");
    // "helper" is defined in utils.ts and used in main.ts
    expect(result.nodes.length).toBeGreaterThanOrEqual(2);

    const symbolNode = result.nodes.find(n => n.id === "helper");
    expect(symbolNode).toBeDefined();
    expect(symbolNode!.type).toBe("symbol");
  });

  // ─── Unknown target: graceful degradation ──────────────────────────

  it("handles unknown file target gracefully", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: "nonexistent-file.ts",
      projectDir: tmpRoot,
    });

    expect(result).toBeDefined();
    expect(result.queryType).toBe("dependencies");
    expect(result.nodes.length).toBeGreaterThanOrEqual(1); // at least the target node
  });

  // ─── Summary strings ──────────────────────────────────────────────

  it("summary starts with 'Static' for fallback path (after fix)", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: path.join("src", "service.ts"),
      projectDir: tmpRoot,
    });

    // Summary starts with "Static" for fallback path
    expect(result.summary).toMatch(/^Static/);
  });

  it("summary includes query type", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: path.join("src", "main.ts"),
      projectDir: tmpRoot,
    });

    expect(result.summary).toContain("dependencies");
  });

  // ─── Multiple queries: singleton caching ───────────────────────────

  it("reuses cached instance across multiple queries", async () => {
    // First query creates the instance (or fails to, triggering fallback)
    await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: path.join("src", "main.ts"),
      projectDir: tmpRoot,
    });

    // Second query should reuse the same cached instance
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "callers",
      target: path.join("src", "utils.ts"),
      projectDir: tmpRoot,
    });

    expect(result).toBeDefined();
    expect(result.queryType).toBe("callers");
  });

  // ─── closeAll lifecycle ────────────────────────────────────────────

  it("closeAll clears instances without error", async () => {
    await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: path.join("src", "main.ts"),
      projectDir: tmpRoot,
    });

    // Should not throw
    expect(() => CodeGraphService.closeAll()).not.toThrow();

    // After closeAll, a new instance would be created on next query
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: path.join("src", "utils.ts"),
      projectDir: tmpRoot,
    });
    expect(result).toBeDefined();
  });

  // ─── Depth parameter ──────────────────────────────────────────────

  it("accepts depth parameter without error", async () => {
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "blast_radius",
      target: path.join("src", "main.ts"),
      depth: 3,
      projectDir: tmpRoot,
    });

    expect(result).toBeDefined();
    expect(result.queryType).toBe("blast_radius");
  });

  // ─── Edge deduplication (validates Finding 3 fix) ─────────────────

  it("deduplicates edges when aggregating across results", async () => {
    // Query dependencies for a target that may produce overlapping results
    const result = await CodeGraphService.queryCodeGraph({
      queryType: "dependencies",
      target: path.join("src", "main.ts"),
      projectDir: tmpRoot,
    });

    // Check no duplicate edges (same source+target pair)
    const edgeKeys = result.edges.map(e => `${e.source}→${e.target}`);
    const uniqueKeys = new Set(edgeKeys);
    expect(edgeKeys.length).toBe(uniqueKeys.size);
  });
});
