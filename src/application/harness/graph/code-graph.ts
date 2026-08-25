import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { log } from "../../../core/log.js";
import type { CodeGraph as CodeGraphType } from "@colbymchenry/codegraph";

// Lazy-import CodeGraph to avoid hard fail when the native binary is absent.
// The import resolves once at first query; subsequent calls use the cached ref.
let _CodeGraphClass: typeof CodeGraphType | null = null;

async function loadCodeGraph(): Promise<typeof CodeGraphType | null> {
  if (_CodeGraphClass) return _CodeGraphClass;
  try {
    const mod = await import("@colbymchenry/codegraph");
    // The CJS interop may expose CodeGraph as a named export or on .default.
    const CG = (mod as Record<string, unknown>).CodeGraph
      ?? (mod as Record<string, unknown>).default;
    if (typeof CG === "function") {
      _CodeGraphClass = CG as unknown as typeof CodeGraphType;
      return _CodeGraphClass;
    }
    return null;
  } catch {
    log.debug("[code-graph] @colbymchenry/codegraph not loadable — native binary missing or incompatible");
    return null;
  }
}

export type QueryType = "dependencies" | "callers" | "callees" | "blast_radius";

export interface CodeGraphQueryOptions {
  queryType: QueryType;
  target: string;
  depth?: number;
  projectDir?: string;
}

export interface NodeInfo {
  id: string;
  name: string;
  type: "file" | "symbol" | "module";
}

export interface EdgeInfo {
  source: string;
  target: string;
  relationship: "imports" | "calls" | "depends_on";
}

export interface CodeGraphQueryResult {
  queryType: QueryType;
  target: string;
  nodes: NodeInfo[];
  edges: EdgeInfo[];
  summary: string;
}

const EDGE_KIND_MAP: Record<string, EdgeInfo["relationship"]> = {
  imports: "imports",
  calls: "calls",
  references: "depends_on",
  extends: "depends_on",
  implements: "depends_on",
};

function mapEdgeKind(kind: string): EdgeInfo["relationship"] {
  return EDGE_KIND_MAP[kind] ?? "depends_on";
}

function nodeTypeFromKind(kind: string): NodeInfo["type"] {
  if (kind === "file") return "file";
  if (kind === "module" || kind === "import" || kind === "export") return "module";
  return "symbol";
}

/**
 * Structural code graph queries via @colbymchenry/codegraph (ADR-027).
 *
 * Attempt 1: library API — CodeGraph.open → query methods.
 * Attempt 2: static regex fallback (unchanged from ADR-002).
 */
export class CodeGraphService {
  private static instances = new Map<string, CodeGraphType>();

  /**
   * Obtain (or create) a cached CodeGraph instance for the given root.
   * Returns null when the library is not loadable or the index doesn't exist.
   */
  private static async getInstance(root: string): Promise<CodeGraphType | null> {
    const cached = CodeGraphService.instances.get(root);
    if (cached) return cached;

    const CG = await loadCodeGraph();
    if (!CG) return null;

    try {
      const cg = await CG.open(root, { sync: false });
      // Connect-time catch-up: reconcile files changed while daemon was offline.
      await cg.sync();
      // Start native OS file watcher (FSEvents/inotify/ReadDirectoryChangesW).
      cg.watch();
      CodeGraphService.instances.set(root, cg);
      log.debug(`[code-graph] opened index for ${root}`);
      return cg;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug(`[code-graph] CodeGraph.open failed for ${root}: ${msg}`);
      return null;
    }
  }

  /**
   * Close all cached CodeGraph instances and release watchers + DB handles.
   * Called from DaemonServer.stop().
   */
  static closeAll(): void {
    for (const [root, cg] of CodeGraphService.instances) {
      try {
        cg.close();
        log.debug(`[code-graph] closed index for ${root}`);
      } catch {
        /* ignore — best-effort cleanup */
      }
    }
    CodeGraphService.instances.clear();
  }

  static async queryCodeGraph(opts: CodeGraphQueryOptions): Promise<CodeGraphQueryResult> {
    const root = opts.projectDir ?? process.cwd();
    const depth = opts.depth ?? 2;

    // Attempt 1: library API
    try {
      const cg = await CodeGraphService.getInstance(root);
      if (cg) {
        const libResult = CodeGraphService.queryViaLibrary(cg, opts, depth);
        if (libResult) return libResult;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug(`[code-graph] library query failed, falling back to static parser: ${msg}`);
    }

    // Attempt 2: static regex fallback
    return CodeGraphService.parseStaticGraph(root, opts.queryType, opts.target, depth);
  }

  private static queryViaLibrary(
    cg: CodeGraphType,
    opts: CodeGraphQueryOptions,
    _depth: number,
  ): CodeGraphQueryResult | null {
    const { queryType, target } = opts;

    switch (queryType) {
      case "dependencies": {
        const results = cg.searchNodes(target);
        if (!results.length) return null;
        const nodes: NodeInfo[] = [];
        const edges: EdgeInfo[] = [];
        for (const r of results) {
          const n = r.node;
          nodes.push({ id: n.id, name: n.name, type: nodeTypeFromKind(n.kind) });
        }
        // Derive dependency edges from the first result's file
        if (results.length > 0 && results[0].node.filePath) {
          const outgoing = cg.getOutgoingEdges(results[0].node.id);
          for (const e of outgoing) {
            if (e.kind === "imports") {
              edges.push({ source: e.source, target: e.target, relationship: "imports" });
            }
          }
        }
        return {
          queryType,
          target,
          nodes,
          edges,
          summary: `CodeGraph library: found ${nodes.length} nodes for '${target}' (dependencies).`,
        };
      }

      case "callers": {
        const results = cg.getCallers(target, _depth);
        if (!results.length) return null;
        const nodes: NodeInfo[] = [{ id: target, name: target, type: "symbol" }];
        const edges: EdgeInfo[] = [];
        for (const { node, edge } of results) {
          nodes.push({ id: node.id, name: node.name, type: nodeTypeFromKind(node.kind) });
          edges.push({ source: edge.source, target: edge.target, relationship: mapEdgeKind(edge.kind) });
        }
        return {
          queryType,
          target,
          nodes,
          edges,
          summary: `CodeGraph library: ${results.length} caller(s) of '${target}'.`,
        };
      }

      case "callees": {
        const results = cg.getCallees(target, _depth);
        if (!results.length) return null;
        const nodes: NodeInfo[] = [{ id: target, name: target, type: "symbol" }];
        const edges: EdgeInfo[] = [];
        for (const { node, edge } of results) {
          nodes.push({ id: node.id, name: node.name, type: nodeTypeFromKind(node.kind) });
          edges.push({ source: edge.source, target: edge.target, relationship: mapEdgeKind(edge.kind) });
        }
        return {
          queryType,
          target,
          nodes,
          edges,
          summary: `CodeGraph library: ${results.length} callee(s) of '${target}'.`,
        };
      }

      case "blast_radius": {
        const sub = cg.getImpactRadius(target, _depth);
        const nodeCount = sub.nodes.size;
        if (nodeCount === 0) return null;
        const nodes: NodeInfo[] = [];
        for (const [, n] of sub.nodes) {
          nodes.push({ id: n.id, name: n.name, type: nodeTypeFromKind(n.kind) });
        }
        const edges: EdgeInfo[] = sub.edges.map(e => ({
          source: e.source,
          target: e.target,
          relationship: mapEdgeKind(e.kind),
        }));
        return {
          queryType,
          target,
          nodes,
          edges,
          summary: `CodeGraph library: blast radius of '${target}' = ${nodeCount} node(s), ${edges.length} edge(s).`,
        };
      }

      default:
        return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Attempt 2 — static regex fallback (unchanged from ADR-002)        */
  /* ------------------------------------------------------------------ */

  private static parseStaticGraph(
    root: string,
    queryType: QueryType,
    target: string,
    depth: number,
  ): CodeGraphQueryResult {
    const nodes: NodeInfo[] = [];
    const edges: EdgeInfo[] = [];
    const visited = new Set<string>();

    const files = CodeGraphService.scanSourceFiles(root);
    const targetFile = files.find(f => f.includes(target) || relative(root, f) === target);

    if (!targetFile && !target.includes("/")) {
      // Symbol query fallback
      nodes.push({ id: target, name: target, type: "symbol" });
      for (const file of files) {
        const rel = relative(root, file);
        try {
          const content = readFileSync(file, "utf-8");
          if (content.includes(target)) {
            nodes.push({ id: rel, name: rel, type: "file" });
            edges.push({ source: rel, target, relationship: "calls" });
          }
        } catch {
          /* ignore */
        }
      }
      return {
        queryType,
        target,
        nodes,
        edges,
        summary: `Static blast-radius analysis found ${nodes.length - 1} files referencing symbol '${target}'.`,
      };
    }

    const start = targetFile ? relative(root, targetFile) : target;
    nodes.push({ id: start, name: start, type: "file" });
    visited.add(start);

    // Scan imports in target file
    if (targetFile && existsSync(targetFile)) {
      try {
        const content = readFileSync(targetFile, "utf-8");
        const importMatches = content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g);
        for (const match of importMatches) {
          const imported = match[1];
          nodes.push({ id: imported, name: imported, type: imported.startsWith(".") ? "file" : "module" });
          edges.push({ source: start, target: imported, relationship: "imports" });
        }
      } catch {
        /* ignore */
      }
    }

    return {
      queryType,
      target: start,
      nodes,
      edges,
      summary: `Structural code graph for '${start}': ${nodes.length} nodes, ${edges.length} edges (depth ${depth}).`,
    };
  }

  private static scanSourceFiles(dir: string, maxFiles = 100): string[] {
    const results: string[] = [];
    const scan = (current: string) => {
      if (results.length >= maxFiles) return;
      try {
        const entries = readdirSync(current);
        for (const entry of entries) {
          if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
          const full = join(current, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            scan(full);
          } else if (/\.(ts|tsx|js|jsx|py|go|rs|java)$/i.test(entry)) {
            results.push(full);
          }
        }
      } catch {
        /* ignore */
      }
    };
    scan(dir);
    return results;
  }
}
